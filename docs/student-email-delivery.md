# Student email delivery (outbox + background worker)

Student welcome emails and teacher "Resend Login Details" emails both go through one persistent outbox, the `EmailDelivery` table. A background worker inside the Next.js server process sends them.

Code:
- `services/student-email-delivery-service.ts`: queueing, processing, retries, resend activation, teacher history and manual retry.
- `services/email-delivery-worker.ts`: the worker loop.
- `lib/email-payload-crypto.ts`: payload encryption.
- Teacher routes:
  - `GET /api/students/email-deliveries` (history);
  - `POST /api/students/email-deliveries/{id}/retry` (manual retry);
  - `POST /api/students/{id}/resend-registration-emails` (Resend Login Details).
- UI: `components/student-email-delivery-history.tsx`, opened from the Students page through **Email Delivery** or a student's **Email history**.

## Deploy checklist (order matters)

1. **Back up the database.**
2. **Apply the two migrations, in this order, BEFORE deploying the code**:
   1. `20261118120000_add_student_password_setup_pending` adds `Student.passwordSetupPending` (NOT NULL, default false). Existing students get `false`.
   2. `20261119120000_add_email_delivery_tracking` adds two enums, the `EmailDelivery` table, its indexes, foreign keys and checks.

   Both are additive: no existing row or column changes. The new code reads both, so student login and registration fail until both exist.

   Verified on 2026-11-16 against a disposable PostgreSQL 18.1:
   - built from the schema at git `HEAD`, seeded with 40 students;
   - both migrations applied in order;
   - the existing student rows were byte-identical;
   - `prisma migrate diff` against `schema.prisma` reported no drift.

   Note: replaying *all* migrations from an empty database fails at the older `20260831035259_add_soft_delete_status_to_material_bundle`. That is a pre-existing problem and doesn't affect existing databases.
3. **Set `EMAIL_PAYLOAD_ENCRYPTION_KEY`** (see *Encryption key operations*) and **back it up before first use**.
   - Without it, accounts are still created, but their welcome email is recorded as FAILED (`EMAIL_PAYLOAD_KEY_MISSING`), and Resend Login Details answers 503 and changes nothing.
4. **Configure an email provider**: Sender.net (`SENDER_API_TOKEN`, `SENDER_FROM_EMAIL`) or SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, …).
   - Without one, emails stay queued and retry with `EMAIL_NOT_CONFIGURED`. They are never marked SENT, and no resend password is activated. This applies in development too, where the mailer silently skips sending.
5. **PM2**: set `kill_timeout` **above** `PROCESS_SHUTDOWN_TIMEOUT_MS` (default 9000), for example:

   ```js
   // ecosystem config of the app process
   { name: "slclassroom", script: "node_modules/next/dist/bin/next", args: "start", kill_timeout: 12000 }
   ```

   PM2's default of 1600 ms SIGKILLs the process before an in-flight email is finished. That is still safe (the row is recovered after its lease expires, possibly as a duplicate email), but not graceful.
6. Restart the app.
7. Check the log for `[EMAIL_WORKER] started pollIntervalMs=… batchSize=… concurrency=…`.

All variables are listed in the tracked template `deploy/slclassroom-app/email-delivery.env.example`. The root `.env.example` is git-ignored by the `.env*` rule, so it is not a reliable place for documentation.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `EMAIL_PAYLOAD_ENCRYPTION_KEY` | (required) | 64 hex characters; AES-256-GCM key for queued temporary passwords. |
| `EMAIL_DELIVERY_MAX_ATTEMPTS` | 5 | Automatic attempts per email (1–20). |
| `EMAIL_DELIVERY_RETRY_BASE_SECONDS` | 60 | First retry delay; it doubles each attempt. |
| `EMAIL_DELIVERY_RETRY_MAX_SECONDS` | 21600 | Backoff cap. |
| `EMAIL_DELIVERY_LEASE_SECONDS` | 300 | Processing lease; at least 2× the send timeout. |
| `EMAIL_DELIVERY_SEND_TIMEOUT_SECONDS` | 60 | One send attempt; past it, the outcome is treated as unknown. |
| `EMAIL_DELIVERY_PAYLOAD_RETENTION_HOURS` | 168 | How long a failed email's encrypted credentials stay retryable. |
| `EMAIL_WORKER_ENABLED` | true | `false` disables the worker in this process. |
| `EMAIL_WORKER_POLL_INTERVAL_SECONDS` | 15 | Poll interval. |
| `EMAIL_WORKER_BATCH_SIZE` | 10 | Rows claimed per pass. |
| `EMAIL_WORKER_CONCURRENCY` | 2 | Parallel sends. |
| `EMAIL_WORKER_SHUTDOWN_TIMEOUT_MS` | 8000 | Wait for the running pass on shutdown. |
| `PROCESS_SHUTDOWN_TIMEOUT_MS` | 9000 | Whole graceful-shutdown budget for all background tasks. Keep PM2 `kill_timeout` larger. |

## Worker

The worker starts once per Node server process, from two places:
- `instrumentation.ts` at production start;
- lazily on the first queued email, which also covers the development server.

It does not depend on any HTTP request staying open. It never runs on serverless platforms (`NETLIFY`, `AWS_LAMBDA_FUNCTION_NAME`), during `next build`, or under the test runner. Set `EMAIL_WORKER_ENABLED=false` to disable it, for example on a second process.

Each pass (every `EMAIL_WORKER_POLL_INTERVAL_SECONDS`, and right after an email is queued or retried) does the following:
- **Claims** up to `EMAIL_WORKER_BATCH_SIZE` due rows. Each claim is one conditional `UPDATE` (status `PENDING` → `PROCESSING`) with a random lease token and lease expiry. Every later write is fenced by that token. Two workers or processes can never process the same row, and a worker that lost its lease changes nothing.
- **Recovers** rows whose lease expired (a crashed or killed worker). The interrupted attempt is recorded as `LEASE_EXPIRED` with an unknown outcome, then retried.
- **Sends** with at most `EMAIL_WORKER_CONCURRENCY` sends at a time, each bounded by `EMAIL_DELIVERY_SEND_TIMEOUT_SECONDS`.
- **Finishes** pending resend activations and clears retained ciphertexts that have expired.

Passes never overlap.

**Graceful shutdown** goes through `lib/process-shutdown.ts`, a coordinator shared with the Recorded Lectures maintenance scheduler.
- `next start` installs its own SIGINT/SIGTERM handler, `server.close(() => process.exit(0))`, before `instrumentation.ts` runs. The coordinator takes that handler off.
- On a signal, it runs every registered task in parallel:
  - the email worker claims nothing new and waits up to `EMAIL_WORKER_SHUTDOWN_TIMEOUT_MS` for its running pass;
  - the maintenance scheduler abandons its claims (≤ 1 s).
- The whole wait is bounded by `PROCESS_SHUTDOWN_TIMEOUT_MS`. Only then does the coordinator hand the signal to Next's handler, which closes the HTTP server and exits as before. With no such handler, it re-raises the signal.
- A second signal skips the wait.
- If the process is killed anyway (PM2 `kill_timeout` too short, or SIGKILL), a row left `PROCESSING` is recovered by the next process after its lease expires. Its attempt is recorded as "outcome unknown", so the email may be sent twice, with the same password.
- On Windows development machines, Node can't deliver real POSIX signals to a child process. The tests exercise the coordinator by emitting the signal events.

**Monitoring:**
- Logs: `[EMAIL_WORKER] pass claimed=… sent=… retry=… failed=… activated=…` and `[EMAIL_DELIVERY] …` lines (ids, codes and categories only; never addresses or passwords).
- Database: rows stuck in `PENDING` with `nextRetryAt` in the past mean the worker isn't running.

  ```sql
  SELECT status, count(*) FROM "EmailDelivery" GROUP BY 1;
  SELECT count(*) FROM "EmailDelivery" WHERE status = 'PENDING' AND "nextRetryAt" < now() - interval '5 minutes';
  ```

## Statuses

| Status | Meaning |
|---|---|
| `PENDING` | Waiting for its first attempt ("Queued") or the next one ("Retrying automatically", `nextRetryAt`). |
| `PROCESSING` | A worker holds it (lease). |
| `SENT` | **Accepted by the email provider.** This is not proof the email reached the inbox; the UI says so. |
| `FAILED` | No more automatic attempts. `lastErrorCode` and `lastErrorMessage` (sanitized) say why. |

Rows are never deleted when sent; the table is the delivery history.

## Retries

Each failure is classified as one of:
- **provider rejection** (Sender 422, SMTP 5xx, `EENVELOPE`): permanent, so `FAILED`;
- **permanent** request error;
- **temporary** (SMTP 4xx, connection refused, DNS, provider rate limit or 5xx): retried;
- **timeout** (`SENDER_TIMEOUT`, `ETIMEDOUT`, our send timeout): retried, outcome unknown;
- **ambiguous** (connection lost mid-send, provider didn't confirm, unknown errors): retried, outcome unknown;
- **configuration** (provider authentication, email not configured): retried, since fixing the configuration resolves it.
  - A send only counts as accepted when the provider returns a positive answer: Sender.net's `{ messageId }`, or the SMTP transport's info with at least one accepted recipient.
  - When the mailer *skips* sending (development without SMTP/Sender.net, so no answer at all), the attempt fails with `EMAIL_NOT_CONFIGURED` ("No email provider is configured…"). It is never SENT, and a resend's new password is never activated.

Retries use exponential backoff: `EMAIL_DELIVERY_RETRY_BASE_SECONDS × 2^(attempt−1)`, capped at `EMAIL_DELIVERY_RETRY_MAX_SECONDS`, for up to `EMAIL_DELIVERY_MAX_ATTEMPTS` attempts.

**Duplicates:** SMTP and HTTP providers cannot guarantee exactly-once delivery. After a timeout or ambiguous failure, the email may already have been sent, and the retry may deliver it again. Every retry carries the **same** credentials, so a duplicate never means two different passwords. The history marks such attempts ("outcome unknown").

## Credentials

- Only the temporary password is sensitive. It is stored AES-256-GCM encrypted in `encryptedPayload`: random IV, authenticated, bound to the row id.
- It is cleared when the provider accepts the email, when the credentials are superseded, or `EMAIL_DELIVERY_PAYLOAD_RETENTION_HOURS` (default 7 days) after a final failure. Until then a teacher can retry.
- Without the payload, a manual retry is refused, and the teacher is told to use Resend Login Details, which issues fresh credentials.
- Fingerprints are SHA-256 of bcrypt *hashes*.
- Before every attempt the worker checks that the credentials are still the student's current ones. If the student changed their password, or a newer resend was activated, the row fails with `CREDENTIALS_SUPERSEDED` and nothing stale is sent.

## Encryption key operations (`EMAIL_PAYLOAD_ENCRYPTION_KEY`)

The key only protects **queued** temporary passwords:
- welcome or resend emails not yet accepted;
- failed emails kept for a manual retry (at most `EMAIL_DELIVERY_PAYLOAD_RETENTION_HOURS`).

Student passwords themselves are bcrypt hashes and never depend on this key. Losing or rotating the key therefore never locks anyone out:
- a resend's old password stays valid until a new email is accepted;
- a welcome email that can no longer be decrypted is recovered with Resend Login Details.

The algorithm (AES-256-GCM, a fresh IV per value, bound to the row id) does not change for rotation.

**Generate** on a trusted machine with `openssl rand -hex 32` (exactly 64 hex characters). Put it in the app server's environment (PM2 ecosystem `env` or the server's env file, readable only by the app user, `chmod 600`).

**Back up:**
- Store a copy in the team's password manager or secrets store **before** the first deploy.
- Never put it in git, the database, database dumps, logs or tickets.
- Keep the key backup and the database backups in different places. Anyone holding both a dump and the key can read the temporary passwords queued at dump time.

**Recover** (key lost, or a server rebuilt without it):
1. Set a new key (as in *Rotate*).
2. Queued rows encrypted with the lost key fail with `EMAIL_PAYLOAD_UNREADABLE`. Find them:

   ```sql
   SELECT "studentId", "emailType", status FROM "EmailDelivery" WHERE "encryptedPayload" IS NOT NULL;
   ```

   Run this before restarting with the new key.
3. Teachers use **Resend Login Details** for those students. The history shows the "Use Resend Login Details" hint on each such row.

**Rotate** (planned, or after suspected exposure):
1. Choose a quiet period. Optionally check that nothing is waiting:

   ```sql
   SELECT status, count(*) FROM "EmailDelivery" WHERE "encryptedPayload" IS NOT NULL GROUP BY 1;
   ```

   The worker usually drains `PENDING` within minutes. `FAILED` rows with a payload are the manual-retry backlog.
2. Note the rows that still have a payload (query above). They become unreadable with the new key.
3. Set the new key, back it up, and restart the app (`pm2 reload`/`restart`, with `kill_timeout` as above).
4. Rows encrypted with the old key fail with `EMAIL_PAYLOAD_UNREADABLE` on their next attempt. Nothing is sent and no password changes. Teachers use Resend Login Details for those students.
5. After suspected exposure:
   - rotate immediately;
   - have teachers resend login details to the students whose temporary passwords were queued at the time;
   - remove the old key from the password manager once no backup that needs it remains.

## Resend Login Details

1. The new password is hashed and stored as `pendingPasswordHash`. The encrypted password is queued. The student's current password is **not** changed.
2. The worker sends the email. Retries reuse the same password.
3. Only after the provider accepts it does one transaction run. It is conditional on the student's password and `sessionVersion` being unchanged since the request. It:
   - activates the new password;
   - increments `sessionVersion`, which ends existing sessions;
   - retires unused reset links;
   - supersedes the student's other open credential emails.

   Devices, approvals, enrolments, the teacher link and `passwordSetupPending` are never touched.
4. If the account changed in between, `activationErrorCode = ACCOUNT_CHANGED`. The emailed password is not active, the old one still works, and the teacher sees this in the history.
5. If activation couldn't run (database error, crash), the row stays "accepted, activation pending", and every worker pass retries it. Activation is idempotent.

Limits per student: one unresolved resend (`activeOperationKey`, unique), one request per 60 seconds, plus the teacher password-reset rate limits.

## Delivery webhooks (not implemented)

Sender.net's transactional API returns an `emailId`, stored as `providerMessageId`. SMTP returns a `messageId`.

Inbox delivery, bounces and opens would need provider webhooks: a public endpoint, signature verification, and mapping by `providerMessageId`. That is an optional future addition, keyed on the stored id. It isn't needed for correctness, and nothing here depends on it.
