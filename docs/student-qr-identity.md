# Student QR identity

Every student can have one active QR identity. The QR encodes an **opaque
token** only — never a database ID, registration number, name or other
personal data. Status: database foundation only (migration
`20261108150000_add_student_qr_tokens`); token generation, APIs, UI and the
scanner come later.

## Storage model (`StudentQrToken`)

| Column | Meaning |
|---|---|
| `id` | Row id (UUID); part of the token derivation |
| `studentId` | The student (cascade on student deletion) |
| `nonce` | 32 random bytes, base64url (43 chars), generated per token |
| `tokenHash` | SHA-256 (hex) of the derived token — unique, used for lookups |
| `reason` | `ISSUE` (first token), `REGENERATE` (student / teacher request), `SYSTEM_REISSUE` (explicit administrative operation) |
| `createdAt` | Real UTC instant, written by the application |
| `createdByRole` / `createdById` | `STUDENT` / `TEACHER` (id required) or `SYSTEM` |
| `revokedAt` | Real UTC instant when replaced; `NULL` = the active token |
| `revokedByRole` / `revokedById` | Who revoked it: `STUDENT` / `TEACHER` (id required) or `SYSTEM`; `NULL` while active |
| `revokedReason` | Why: `REGENERATE` (by a student / teacher) or `SYSTEM_REISSUE` (by `SYSTEM`); `NULL` while active |

The token itself is **never stored**. It is derived when a QR is rendered:

```
token     = base64url( HMAC-SHA256( STUDENT_QR_SECRET, "slc-student-qr:v1:" + id + ":" + nonce ) )
tokenHash = hex( SHA-256( token ) )
payload   = "SLCQR1:" + token
```

A database leak alone therefore cannot produce a valid QR.

## Hand-written SQL in the migration

Prisma 5.22 cannot express these; they live only in the migration SQL:

- `StudentQrToken_one_active_per_student`:
  `UNIQUE ("studentId") WHERE "revokedAt" IS NULL` — at most one active token
  per student, so concurrent issues / regenerations can never leave two.
- CHECK constraints: `createdByRole` in `STUDENT`/`TEACHER`/`SYSTEM`;
  `createdById` required unless `SYSTEM`; `nonce` is 43 base64url characters;
  `tokenHash` is a 64-character lowercase hex digest (which also rejects a raw
  token stored by mistake); `revokedAt >= createdAt`.
- Revocation audit CHECKs: `revokedByRole` in `STUDENT`/`TEACHER`/`SYSTEM`;
  `revokedReason` in `REGENERATE`/`SYSTEM_REISSUE`; and
  `StudentQrToken_revocation_audit_check` — an active row (`revokedAt` NULL)
  has all revocation fields NULL, a revoked row has `revokedByRole` and
  `revokedReason` (plus `revokedById` unless `SYSTEM`), and `SYSTEM_REISSUE`
  is used exactly when the revoker is `SYSTEM`.

`prisma migrate dev` / `migrate diff` may show the partial index as drift and
generate `DROP INDEX "StudentQrToken_one_active_per_student"`. **Never commit
such a statement.** `tests/student-qr/student-qr-migration-guard.test.cjs`
fails if the hand-written SQL is lost or altered.

## Timestamps

`createdAt` and `revokedAt` have **no database default**. The application
writes them as real UTC instants (`new Date()`), because the database session
timezone (Europe/Berlin in production) would otherwise turn `now()` into local
wall-clock digits in these `timestamp without time zone` columns — which would
distort the rolling 24-hour regeneration limit.

## `STUDENT_QR_SECRET`

- A **separate, server-only** secret: at least **32 random bytes** (e.g.
  `openssl rand -base64 48`). Never reuse `JWT_SECRET` or any other secret,
  never prefix it with `NEXT_PUBLIC_`, never log it.
- Format: base64 or base64url text (hex text from `openssl rand -hex 32` is
  also accepted, since hex characters are valid base64). The decoded bytes are
  the HMAC key. Loaded and validated by `loadStudentQrSecret()` in
  `lib/student-qr-token.ts`, which rejects: missing / blank, non-base64 text,
  fewer than 32 decoded bytes, obvious placeholders (fewer than 16 distinct
  byte values) and a value equal to `JWT_SECRET`. It cannot measure true
  randomness: always generate the value with `openssl rand`.
- Missing or invalid: QR features are disabled (the service answers
  "not configured"); nothing falls back to another secret.
- Must be set on every server before the QR features are deployed.

## Secret rotation (explicit administrative operation only)

Changing `STUDENT_QR_SECRET` changes every derived token, so **every existing
QR — printed or downloaded — stops working**. Therefore:

1. Rotation is **never automatic**. Normal QR rendering **never** creates new
   tokens: if a derived token does not match its stored `tokenHash` (secret
   changed or corrupted), rendering fails with a clear error instead of
   silently reissuing.
2. Rotation is a planned administrative operation, with approval:
   announce it, set the new secret, restart the app, then run the explicit
   reissue operation, which revokes each active token and creates a
   `SYSTEM_REISSUE` replacement (not counted towards the regeneration limit).
3. Students and teachers must then download / print the new QR codes.

## Regeneration and revocation (`services/student-qr-service.ts`)

- Regenerating revokes the active token (setting `revokedAt`, `revokedByRole`,
  `revokedById`, `revokedReason` together) and inserts a new one in
  one transaction, with the student row locked so the limit check is exact.
- Limit: **5 successful `REGENERATE` rows per student in any rolling 24 hours**
  (student and teacher requests combined); first issues and system reissues
  are not counted.
- Revoked rows are kept (audit); their hashes stay unique, so an old QR can
  never match again.

## Service behaviour (`services/student-qr-service.ts`)

- `getOrCreateActiveToken(studentId, actor)`: returns the active token
  (issuing the first one, reason `ISSUE`, under the student row lock).
  Idempotent; concurrent first views produce exactly one row.
- `regenerateToken(studentId, actor)`: one transaction —
  `SELECT ... FOR NO KEY UPDATE` on the student (serialises QR operations; foreign-key inserts such as attendance are not blocked), count `REGENERATE` rows of the
  last 24 hours, revoke + insert. Over the limit: `QR_REGENERATION_LIMIT`
  (429) with `{ limit, retryAfterSeconds, retryAt }`. A `SYSTEM` actor cannot
  regenerate.
- `getQrStatus(studentId)`: quota and whether a token exists; no token data.
- `resolveQrPayload(payload)`: returns only `studentId`, `teacherId`, `name`,
  `registrationNumber`, `isActive`. Unknown, revoked or malformed payloads all
  fail as `INVALID_QR_PAYLOAD`.
- Actors: `STUDENT` only for itself, `TEACHER` only for an owned student
  (otherwise `STUDENT_NOT_FOUND`); routes check this too. Deleted students
  (status 2) are not found.
- A stored token that no longer verifies (secret changed) fails as
  `QR_TOKEN_UNVERIFIABLE` and is never reissued automatically.
- Database errors on token writes are replaced by a generic error so the
  PostgreSQL row detail (nonce, tokenHash) cannot reach route logs; the shared Prisma client (`lib/prisma.ts`) logs only sanitized one-line summaries (`formatPrismaLogEvent`).
