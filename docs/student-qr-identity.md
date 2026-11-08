# Student QR identity

Every student can have one active QR identity. The QR encodes an **opaque
token** only — never a database ID, registration number, name or other
personal data.

Status: database model, token crypto, service, student and teacher APIs and
UI, and the operator tool for secret rotation are implemented. Not
implemented yet: the QR **scanner**.

| Layer | File |
|---|---|
| Migration | `prisma/migrations/20261108150000_add_student_qr_tokens/migration.sql` |
| Token crypto (server-only) | `lib/student-qr-token.ts` |
| Service | `services/student-qr-service.ts` |
| HTTP helpers | `lib/student-qr-http.ts`, `lib/same-origin.ts` |
| Student routes | `app/api/students/me/qr/**` |
| Teacher routes | `app/api/students/[id]/qr/**` |
| UI | `components/qr/qr-identity-card.tsx` (shared), `components/student-portal/student-qr-panel.tsx`, `app/student/Components/StudentQrIdentity.tsx` |
| Secret rotation (operator CLI only) | `scripts/student-qr-reissue.ts`, `services/student-qr-reissue-service.ts` |

## API endpoints

All eight routes: `dynamic = "force-dynamic"`, and every response — success
or error — carries `Cache-Control: private, no-store, max-age=0`,
`Pragma: no-cache`, `Expires: 0`, `Vary: Cookie`. JSON responses never
contain a token, nonce, hash or secret; the token only ever leaves the server
drawn inside a PNG.

### Student (`/api/students/me/qr`)

| Method & path | Behaviour |
|---|---|
| `GET /api/students/me/qr/status` | `{ configured, hasActiveToken, regenerationLimit, regenerationsRemaining, nextRegenerationAt }` |
| `POST /api/students/me/qr/issue` | Same-origin only. Issues the first QR (reason `ISSUE`) if there is none; idempotent; never counted towards the limit. Returns the status |
| `GET /api/students/me/qr` | PNG (512 px, error correction M). **Read-only**: without an active QR → 404 `QR_TOKEN_NOT_FOUND`. `?download=1` only switches to `Content-Disposition: attachment` |
| `POST /api/students/me/qr/regenerate` | Same-origin only. Replaces the QR; returns the status; at the limit 429 + `Retry-After` + `{ limit, retryAfterSeconds, retryAt }` |

### Teacher (`/api/students/[id]/qr`)

| Method & path | Behaviour |
|---|---|
| `GET /api/students/[id]/qr/status` | Same safe status fields |
| `POST /api/students/[id]/qr/issue` | Same-origin only. Issues the first QR (`createdByRole = TEACHER`) if there is none; idempotent; not counted |
| `GET /api/students/[id]/qr` | PNG. **Read-only**: without an active QR → 404 `QR_TOKEN_NOT_FOUND`; `?download=1` = attachment |
| `POST /api/students/[id]/qr/regenerate` | Same-origin only. Same limit (shared with the student) and 429 behaviour |

### Error codes

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | No / invalid session, or the wrong role for the route |
| 403 | `CROSS_ORIGIN_REQUEST_REJECTED` | A POST failed the same-origin check (see below) |
| 404 | `STUDENT_NOT_FOUND` | Unknown student, another teacher's student, or a deleted student (status 2) |
| 404 | `QR_TOKEN_NOT_FOUND` | GET image / regenerate before a QR was issued |
| 429 | `QR_REGENERATION_LIMIT` | 6th regeneration within 24 hours |
| 503 | `STUDENT_QR_NOT_CONFIGURED` | `STUDENT_QR_SECRET` missing or invalid (the status route still answers, with `configured: false`) |
| 503 | `QR_TOKEN_UNVERIFIABLE` | The stored QR does not verify under the current secret (secret changed): never reissued automatically |

## Authorization rules

- **Student routes** (`/me`): `requireStudentSession()`; the student is always
  the session's own student. No student id is read from the URL, query or
  body. Teacher and admin sessions get 401.
- **Teacher routes** (`/[id]`): `requireTeacherOwnedStudent` (the T1 guard,
  `lib/teacher-student-access.ts`): 401 without a teacher session; 404
  `STUDENT_NOT_FOUND` — with no student data — for an unknown student or
  another teacher's student. The student comes from the URL and is checked
  against the signed-in teacher; any body is ignored.
- **The service re-checks** every write and read: a `STUDENT` actor only for
  itself, a `TEACHER` actor only for a student whose `teacherId` matches;
  otherwise `STUDENT_NOT_FOUND`. Deleted students (status 2) never get a QR.
- **Same-origin (CSRF) protection** on every POST (`lib/same-origin.ts`),
  checked **before** the session or the database is touched:
  `Sec-Fetch-Site`, when sent, must be `same-origin`; `Origin` must be present
  and equal (scheme, host, port) to `APP_URL` or `NEXT_PUBLIC_APP_URL`.
  `Host` / `X-Forwarded-Host` are never trusted. With neither variable set,
  every POST is refused (fail closed) and the server warns.
- **GET requests are read-only**: they never issue, regenerate or reissue.
- Middleware (`/api/students/:path*`) already answers 401 to requests
  without a session cookie; the routes check again.

## Token lifecycle

```
            POST /issue (student or owning teacher)          POST /regenerate (≤ 5 / 24 h, shared)
 (none) ───────────────────────────────────────► ACTIVE ─────────────────────────────────────► REVOKED
                                                   ▲                                              │
                                                   └──────────── new ACTIVE row (REGENERATE) ◄────┘
```

1. **Issue** — the first QR is created only by an explicit POST `/issue`
   (the UI calls it when the status says there is none). Reason `ISSUE`,
   `createdByRole/createdById` = the student or the teacher. Idempotent.
   Never counted towards the limit.
2. **Render** — GET image routes re-derive the token from the active row,
   verify it against `tokenHash` (constant time) and draw the PNG. A mismatch
   is `QR_TOKEN_UNVERIFIABLE`; nothing is written.
3. **Regenerate** — one transaction: `SELECT ... FOR NO KEY UPDATE` on the
   student (serialises QR operations; foreign-key inserts such as attendance
   are not blocked), count `REGENERATE` rows of the rolling 24 hours (limit 5,
   student and teacher combined), revoke the active row (`revokedAt`,
   `revokedByRole`, `revokedById`, `revokedReason = REGENERATE` together) and
   insert the `REGENERATE` replacement. Either both commit or neither.
4. **Revoked** rows are kept for audit; their hashes stay unique, so an old QR
   never matches again. A scanned revoked QR is `INVALID_QR_PAYLOAD`.
5. **Resolve** (`resolveQrPayload`, for the future scanner) returns only
   `studentId`, `teacherId`, `name`, `registrationNumber`, `isActive`.
6. **System reissue** — only by the operator CLI during a secret rotation:
   the active token is revoked by `SYSTEM` (`revokedReason = SYSTEM_REISSUE`,
   `revokedById` NULL) and replaced by a `SYSTEM_REISSUE` row
   (`createdByRole = SYSTEM`, `createdById` NULL) derived with the new
   secret. Not counted towards the regeneration limit.

## Storage model (`StudentQrToken`)

| Column | Meaning |
|---|---|
| `id` | Row id (UUID); part of the token derivation |
| `studentId` | The student (cascade on student deletion) |
| `nonce` | 32 random bytes, base64url (43 chars), generated per token |
| `tokenHash` | SHA-256 (hex) of the derived token — unique, used for lookups |
| `reason` | `ISSUE` (first token), `REGENERATE` (student / teacher request), `SYSTEM_REISSUE` (administrative operation) |
| `createdAt` | Real UTC instant, written by the application |
| `createdByRole` / `createdById` | `STUDENT` / `TEACHER` (id required) or `SYSTEM` |
| `revokedAt` | Real UTC instant when replaced; `NULL` = the active token |
| `revokedByRole` / `revokedById` | Who revoked it: `STUDENT` / `TEACHER` (id required) or `SYSTEM`; `NULL` while active |
| `revokedReason` | `REGENERATE` (by a student / teacher) or `SYSTEM_REISSUE` (by `SYSTEM`); `NULL` while active |

The token itself is **never stored**. It is derived when a QR is rendered:

```
token     = base64url( HMAC-SHA256( key(STUDENT_QR_SECRET), "slc-student-qr:v1:" + id + ":" + nonce ) )
tokenHash = hex( SHA-256( token ) )
payload   = "SLCQR1:" + token          (50 characters)
```

A database leak alone therefore cannot produce a valid QR.

### Hand-written SQL in the migration

Prisma 5.22 cannot express these; they live only in the migration SQL:

- `StudentQrToken_one_active_per_student`:
  `UNIQUE ("studentId") WHERE "revokedAt" IS NULL` — at most one active token
  per student.
- CHECK constraints: `createdByRole` in `STUDENT`/`TEACHER`/`SYSTEM`;
  `createdById` required unless `SYSTEM`; `nonce` is 43 base64url characters;
  `tokenHash` is 64 lowercase hex characters (also rejects a raw token stored
  by mistake); `revokedAt >= createdAt`.
- Revocation audit CHECKs: `revokedByRole` in `STUDENT`/`TEACHER`/`SYSTEM`;
  `revokedReason` in `REGENERATE`/`SYSTEM_REISSUE`; and
  `StudentQrToken_revocation_audit_check` — an active row has all revocation
  fields NULL, a revoked row has `revokedByRole` and `revokedReason` (plus
  `revokedById` unless `SYSTEM`), and `SYSTEM_REISSUE` is used exactly when
  the revoker is `SYSTEM`.

`prisma migrate dev` / `migrate diff` may show the partial index as drift and
generate `DROP INDEX "StudentQrToken_one_active_per_student"`. **Never commit
such a statement.** `tests/student-qr/student-qr-migration-guard.test.cjs`
fails if the hand-written SQL is lost or altered.

### Timestamps

`createdAt` and `revokedAt` have **no database default**. The application
writes them as real UTC instants (`new Date()`), because the database session
timezone (Europe/Berlin in production) would otherwise turn `now()` into local
wall-clock digits in these `timestamp without time zone` columns — which would
distort the rolling 24-hour regeneration limit.

## `STUDENT_QR_SECRET`

### Generating it

Generate a fresh value on a trusted machine, once per environment (testing
and production must have **different** values):

```sh
openssl rand -base64 48
```

(48 random bytes. The secret must be at least **32 random bytes**.
Never use a word, a passphrase, a value from documentation or an AI answer.)

### Configuring it

- Put it in the server environment the app process reads (e.g. the
  production `.env` used by PM2, or the process manager's environment) as
  `STUDENT_QR_SECRET=<generated value>`. Restart the app to load it.
- It is a **separate, server-only** secret: never reuse `JWT_SECRET` or any
  other secret, never prefix it with `NEXT_PUBLIC_`, never commit it, never
  log it, never paste it into tickets or chats.
- Store a copy in the team's password manager: losing it is equivalent to a
  rotation (every QR stops working).

### Validation

`loadStudentQrSecret()` (`lib/student-qr-token.ts`) reads it on every use and
rejects: missing / blank, non-base64 text, fewer than 32 decoded bytes,
obvious placeholders (fewer than 16 distinct byte values) and a value equal to
`JWT_SECRET`. Hex text (`openssl rand -hex 32`) is accepted too. It cannot
measure true randomness — always generate the value with `openssl rand`.

Missing or invalid: QR issuance, images and regeneration answer 503
`STUDENT_QR_NOT_CONFIGURED`, the status route answers `configured: false`, and
the server prints `[student-qr] QR codes are unavailable: <problem>` at most
every 10 minutes (naming the problem, never the value). Nothing falls back to
another secret and nothing generates one.

### Server-only enforcement

`lib/student-qr-token.ts` starts with `import "server-only"` (the build fails
if a Client Component imports it) and also refuses to run in a browser at
runtime. Only `services/student-qr-service.ts` imports it; the service is only
imported by the API routes and `lib/student-qr-http.ts`.

## Secret rotation (explicit administrative operation only)

Changing `STUDENT_QR_SECRET` changes every derived token, so **every existing
QR — printed or downloaded — stops working** and every active token must be
reissued under the new secret.

1. Rotation is **never automatic**. Normal QR rendering **never** creates new
   tokens, and neither do issuing or resolving: a stored QR that does not
   verify under the current secret fails as `QR_TOKEN_UNVERIFIABLE` (503), and
   the rows stay untouched.
2. Rotate only on a confirmed or suspected compromise of the secret (or a
   planned key change), with approval.
3. Reissuance is done **only** by the operator CLI
   `scripts/student-qr-reissue.ts` (`npm run qr:reissue`). There is no HTTP
   endpoint; no route, page, middleware or startup code imports it (a test
   enforces this).

### What the tool does

- Reads the secrets **only** from the environment —
  `STUDENT_QR_SECRET_OLD` (the secret the application uses now) and
  `STUDENT_QR_SECRET_NEW` — never from arguments or files. Unknown arguments
  are rejected without being echoed.
- Validates both with the normal rules (≥ 32 random bytes, not `JWT_SECRET`)
  and refuses identical secrets (also the same key in another encoding).
- Classifies every active token by re-deriving it: verifies with the **old**
  secret → to be reissued; with the **new** secret → already reissued (left
  alone); with **neither** → the whole run **refuses** and changes nothing
  (tokens are never skipped silently).
- **Dry run** (default): that classification inside a `READ ONLY`
  transaction — no locks, no writes.
- **Execute**: one transaction, all or nothing. It locks every `Student` row
  (`FOR NO KEY UPDATE`, the lock QR issuance and regeneration take; foreign-key
  inserts such as attendance are not blocked), reads the active tokens, revokes
  each old-secret token (`revokedAt` = one application UTC instant,
  `revokedByRole = SYSTEM`, `revokedById` NULL, `revokedReason = SYSTEM_REISSUE`)
  and inserts its replacement (new row id and nonce, `reason = SYSTEM_REISSUE`,
  `createdByRole = SYSTEM`, `createdById` NULL, same `createdAt`; only nonce
  and hash stored), then re-verifies everything before committing. QR issuance
  and regeneration requests that arrive meanwhile wait (lock timeout 30 s for
  the tool) and run after the commit.
- Re-running is safe: already reissued tokens are recognised by the new
  secret; no duplicates are ever created.
- Output: the target `host:port/database` and counts only — never a secret,
  token, nonce, hash, credential or row contents. Exit codes: 0 done / nothing
  to do, 1 refused or failed, 2 usage error.

### Procedure

Run on the production server (the tool uses `DATABASE_URL`, which Prisma also
loads from the project `.env`). Plan a short window: QR images are unavailable
from step 5 until step 6 completes.

1. **Announce** the change: students and teachers must download / print their
   new QR codes afterwards.
2. **Generate the replacement secret** on a trusted machine and store it in the
   team's password manager **before** using it (losing it after the rotation
   means rotating again):

   ```sh
   openssl rand -base64 48
   ```

3. **Load both secrets into the shell environment** without putting them in
   the shell history, a file or the command line (bash):

   ```sh
   read -rs STUDENT_QR_SECRET_OLD && export STUDENT_QR_SECRET_OLD   # paste the CURRENT secret, Enter
   read -rs STUDENT_QR_SECRET_NEW && export STUDENT_QR_SECRET_NEW   # paste the NEW secret, Enter
   ```

4. **Dry run** (no writes):

   ```sh
   npm run qr:reissue
   ```

   Check the target database line and the counts. "verify with neither" must
   be 0; otherwise `STUDENT_QR_SECRET_OLD` is not the secret in use (see
   Recovery).
5. **Execute** (`<database>` = the database name shown as the target):

   ```sh
   npm run qr:reissue -- --execute --confirm-reissue-all-student-qr --confirm-database=<database>
   ```

   From the commit on, the still-running application (old secret) answers
   `QR_TOKEN_UNVERIFIABLE` (503, shown as "not available") for every reissued
   QR — expected until step 6.
6. **Switch the application to the new secret** immediately: set
   `STUDENT_QR_SECRET` to the new value in the application's environment
   (production `.env` / PM2 environment) and restart the app so it loads it
   (e.g. `pm2 restart <app> --update-env`).
7. **Catch-up run**: repeat step 5. It reissues the few tokens the old
   application may have created between steps 5 and 6 (a first issue or a
   regeneration made in that window used the old secret). Repeat the dry run
   until it reports 0 to reissue and 0 unverifiable.
8. **Verify**: as a student and as a teacher, open a QR (it loads and
   decodes); an old printed QR no longer resolves.
9. `unset STUDENT_QR_SECRET_OLD STUDENT_QR_SECRET_NEW`, close the shell, and
   destroy the old secret everywhere.

### Availability impact

- Old printed / downloaded QR codes stop working permanently at step 5.
- Between step 5 and the restart in step 6, every student with a QR sees
  "QR codes are not available right now" (503) in Settings and on the teacher
  profile. Keep the window short (minutes).
- During the execute transaction itself (seconds), QR issuance and
  regeneration requests wait for it; attendance and other writes are not
  blocked.
- Regeneration quotas are unaffected (`SYSTEM_REISSUE` is never counted).

### Recovery

| Situation | State | What to do |
|---|---|---|
| Refused: invalid / identical secrets, "verify with neither" > 0, missing confirmation | **Nothing changed** | Fix the input. "Neither" usually means `STUDENT_QR_SECRET_OLD` is not the secret the app uses — check the application environment. If some tokens still fail with the right secret, stop and investigate (corrupted rows or an earlier, unfinished rotation with a third secret); do not force anything. |
| Execute failed (database error, lock timeout, connection lost, killed) | **Rolled back completely** — one transaction; the app keeps working with the old secret | Fix the cause (e.g. retry outside peak time), then run the dry run and execute again. |
| Execute succeeded, app not switched yet / restart failed | QR images unavailable (503) | Complete step 6. To abandon the rotation instead, run the tool **reversed** (`STUDENT_QR_SECRET_OLD` = the new secret, `STUDENT_QR_SECRET_NEW` = the old one): it reissues everything back under the old secret. The QR codes change again either way. |
| Some QRs still unavailable after the switch | Tokens created by the old app in the window | Catch-up run (step 7). |
| New secret lost after execute | Reissued tokens cannot be verified | Rotate again to a fresh secret: with neither secret known the tool refuses, so this needs developer help. Prevent it with step 2. |

## Deployment prerequisites

Before enabling QR codes in an environment:

1. **Migration** `20261108150000_add_student_qr_tokens` applied (additive:
   one enum, one table, indexes and constraints; no backfill). Apply it with
   the project's normal migration process after review — and check that the
   partial index `StudentQrToken_one_active_per_student` and the CHECK
   constraints exist afterwards. Known issue: the two duplicate
   `MaterialBundle.status` migrations prevent replaying the full history on a
   fresh database; existing databases are not affected.
2. **`STUDENT_QR_SECRET`** generated and configured (above).
3. **`APP_URL` or `NEXT_PUBLIC_APP_URL`** set to the public origin, e.g.
   `https://slclassroom.live` (scheme + host, no trailing path needed).
   Without it every QR POST (issue, regenerate) is refused with 403.
4. Dependencies installed with pnpm from `pnpm-lock.yaml`
   (`qrcode`, `server-only`; `@types/qrcode`, `jsqr` are dev-only).
5. After deploying: sign in as a student, open Settings → My QR Identity,
   confirm the QR loads and decodes; as the owning teacher, open the
   student's profile → QR Identity.

## Logging

No QR route or the service logs tokens, nonces, hashes, payloads or secrets.
Database errors on token writes are replaced by a generic error, and the
shared Prisma client (`lib/prisma.ts`) prints only sanitized one-line
summaries (`formatPrismaLogEvent`), so PostgreSQL row details (which would
include `nonce` / `tokenHash`) never reach stdout or the error log.

## Tests

| Command | Covers |
|---|---|
| `npm run test:student-qr` | Migration guard, token crypto (incl. server-only), student + teacher routes (in-memory) |
| `STUDENT_QR_TEST_DATABASE_URL=postgresql://user@127.0.0.1:<port>/qr_<name> npm run test:student-qr-db` | Service and secret rotation (incl. the CLI) against a **throwaway local** PostgreSQL that already has the migration (refuses non-local hosts, other database names and — for the rotation tests — databases holding active tokens they did not create) |
