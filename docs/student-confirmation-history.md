# Student confirmation history

Teachers confirm (approve) or decline students. Every decision is recorded in
`StudentConfirmationHistory`, in the same transaction as the change to the
student, so the history can later answer "was this student approved during
that lecture?" (`approvalDuring`, used by attendance from Stage 5 on).

## Decisions

| Action | Allowed from | Where |
|---|---|---|
| Confirm | PENDING | List (desktop and mobile), "Confirm all pending" |
| Decline | PENDING | List (desktop) |
| Decline | APPROVED | List, after a confirmation popover |
| Confirm again | REJECTED | List, after a confirmation popover |

- Deleted students (`status 2`) have no decision buttons.
- Inactive students (`status 1`) can be decided one by one.
- **Confirm all pending** approves only **active** (`status 0`) pending
  students. Inactive and deleted pending students are left pending.
- **Declining an already confirmed student** blocks new sign-ins and new live
  class joins at once. A student who is already signed in **stays signed in
  until their session expires** (sessions are stateless 7-day tokens and
  cannot be revoked yet). The popover says so.

### Student fields

| Field | Meaning |
|---|---|
| `confirmationStatus` | Current state: PENDING, APPROVED or REJECTED |
| `confirmedAt` | Time of the **latest** decision (approve or decline). Null: no decision was ever made |
| `confirmedById` | Teacher who made the latest decision. Null when no teacher decided |
| `approvedAt` | **First** approval. Never overwritten or cleared |

`confirmedById` and `confirmedAt` stay null when a student is **created**
already approved (Add Student, import), or registers through a public class
page (pending). Those are not decisions. Existing rows were not backfilled.

## How a decision is written

`services/student-service.ts`:

- **One student** (`decideStudentConfirmation`, behind `confirmStudent` and
  `declineStudent`), in one interactive transaction:
  1. `SET LOCAL lock_timeout = '3000ms'`.
  2. Lock the teacher's student row: `SELECT ... FOR NO KEY UPDATE`.
  3. Check the **locked** status: missing or another teacher's → 404; already
     in the requested state → 409, nothing written.
  4. `decidedAt = max(now, previous confirmedAt + 1 ms)`, read after the lock.
  5. Update the status, `confirmedAt`, `confirmedById`; on approval set
     `approvedAt` only if it is null.
  6. Insert one history row: the locked previous status and `confirmedAt`.

  After the commit, fee waivers are recalculated when the old or the new status
  is APPROVED.
- **Confirm all pending** (`confirmAllPendingStudents`), in one transaction:
  lock the teacher's active pending students `ORDER BY "id"`, approve exactly
  those rows, insert one history row each (`BULK`, one shared `batchId` and
  instant). A student declined while the bulk run waited for it is skipped:
  PostgreSQL re-checks the `WHERE` after the wait. Fee waivers are recalculated
  for the approved students only.
- A lock wait over 3 seconds, or a deadlock: 409 `STUDENT_DECISION_BUSY`,
  nothing written.

Concurrent decisions on one student therefore run one after the other, and
both are recorded truthfully (for example PENDING → APPROVED, then APPROVED →
REJECTED). A repeated decision gets a 409 and writes no duplicate row.

### API errors

`PUT /api/students/[id]/confirm`, `PUT /api/students/[id]/decline` and
`PUT /api/students/confirm-all` answer errors as
`{ success: false, error: { message, code } }`:

| Status | Code |
|---|---|
| 401 | `UNAUTHORIZED` |
| 404 | `STUDENT_NOT_FOUND` |
| 409 | `STUDENT_ALREADY_APPROVED`, `STUDENT_ALREADY_REJECTED`, `STUDENT_DECISION_BUSY` |
| 500 | `INTERNAL_SERVER_ERROR` |

Success bodies are unchanged (`{ success, message }`, plus `count` for confirm
all, which is the number actually approved).

`POST /api/students/import` accepts `registrationSource` `IMPORT` or `TEACHER`
(missing keeps the default, `TEACHER`). Anything else, including
`PUBLIC_CLASS` and `ADMIN`, is refused with 400 `VALIDATION_ERROR`.

## Historical approval: `approvalDuring`

`lib/student-confirmation-history.ts`. Pure (no database, environment or
clock). Applies to **every** registration source. (The automatic joining fee
waiver keeps its own, public-registration-only rule in `lib/fee-waiver.ts`,
unchanged.)

```ts
approvalDuring(student, history, { start, end }, context)        // any moment of [start, end): APPROVED | NOT_APPROVED | UNKNOWN
explainApprovalDuring(student, history, { start, end }, context) // { result, reason }
approvalAt(student, history, instant, context)                   // at one instant: APPROVED | NOT_APPROVED | UNKNOWN
explainApprovalAt(student, history, instant, context)            // { result, reason }
confirmationTimeline(student, history, context)                  // periods, or null when broken
```

- `student`: `{ confirmationStatus, confirmedAt, approvedAt }`.
- `history`: **all** of the student's `StudentConfirmationHistory` rows.
- The window is the half-open UTC interval `[start, end)`.
- `context`: `{ approvalFeatureStartedAt }`, **required** (see
  [Configuration](#configuration-approval_feature_started_at)). A missing or
  invalid context throws: nothing is evaluated without it.

### How it decides

1. **Chain check**, in `(decidedAt, id)` order: each row's `fromStatus` is the
   previous row's `toStatus`, each `previousConfirmedAt` is the previous row's
   `decidedAt`, decisions are strictly ordered, and the last row matches the
   student's current status and `confirmedAt`. Any break, an impossible start
   (PENDING with a previous decision time, REJECTED without one) or an invalid
   `approvedAt` → `UNKNOWN` (`BROKEN_HISTORY`).
2. **Starting point:** the first row's `fromStatus` and `previousConfirmedAt`
   (no history: the current status and `confirmedAt`).
3. **Known from** (H1):
   - the starting timestamp, when there is one (a real decision);
   - otherwise `approvalFeatureStartedAt`, or the first recorded decision if
     that is earlier (a genuine decision proves the feature existed then).

   Everything earlier is unknown: `BEFORE_RECORDED_DECISIONS` (decisions made
   before history was recorded) or `BEFORE_APPROVAL_FEATURE`.

   Why: the migration that introduced approvals
   (`20260719181532_student_approval_device_security`) gave every existing
   student PENDING with no `confirmedAt`, although no approval existed when
   they were created. "PENDING, never decided" only means something once
   approval was enforced (commit `e8a9242`, deployed at a time the database
   does not record).
4. **`approvedAt`** (M1). The period that contains it (start included):
   - unknown → it is evidence of approval at that instant
     (`APPROVED_AT_EVIDENCE` for windows containing it);
   - APPROVED → consistent;
   - PENDING or REJECTED → a contradiction: that whole period becomes unknown
     (`APPROVED_AT_CONFLICT`) and `approvedAt` is not used as evidence. (For a
     student who is still declined, that period is open-ended: their later
     lectures go to manual review until the next decision.)
5. **Answer:** `APPROVED` (`KNOWN_APPROVED`) if an approved period overlaps
   the window (approved at **any** moment counts), or `APPROVED_AT_EVIDENCE`;
   otherwise `UNKNOWN` if the window reaches an unknown period (reason:
   `APPROVED_AT_CONFLICT`, else `BEFORE_RECORDED_DECISIONS`, else
   `BEFORE_APPROVAL_FEATURE`); otherwise `NOT_APPROVED`
   (`KNOWN_NOT_APPROVED`).

`registeredAt` and `createdAt` are **never** used. Both come from the database
default `CURRENT_TIMESTAMP` into `timestamp without time zone` columns, whose
value depends on the database session timezone, and every student who existed
before `registeredAt` was added got that migration's run time.

Only `APPROVED` is automatically eligible (`isAutomaticallyEligible`).
`UNKNOWN` never creates an automatic absence or automatic QR attendance, and is
never treated as eligible or ineligible automatically: it is left for the
teacher to review (`needsManualApprovalReview`).

### Point in time: `approvalAt`

`approvalAt` / `explainApprovalAt` evaluate the same timeline (the H1
known-from point, the M1 `approvedAt` conflicts, the chain checks) at **one
instant**, with the same reasons.

- Periods are half-open `[from, to)`: a decision recorded exactly at the
  instant already applies at that instant; the moment before belongs to the
  previous period.
- An `approvedAt` inside an unknown period is evidence only at its exact
  instant; inside a conflicting period it is never evidence.
- An invalid instant, or a missing / invalid context, throws.
- The largest valid JavaScript Date (`8.64e15` ms, year 275760;
  `MAX_JS_DATE_MS`) is outside the supported range: it has no following
  millisecond, so `approvalAt` throws a `RangeError` ("the instant is outside
  the supported range") instead of evaluating it. Every other valid Date,
  including the minimum, is evaluated normally.

`approvalDuring` keeps its meaning (approved at **any moment** of the window)
for historical information and reporting. It is **not** used for automatic
attendance decisions: a student approved only for part of a lecture (approved
at 11:55 in a 10:30–12:00 lecture, or declined at 11:00) is "approved during"
it, but must not get an automatic absence on that basis.

### Attendance usage (approved rules; Stage 5, not implemented yet)

| Use | Approval evaluated with `approvalAt` at |
|---|---|
| Initial roster eligibility | the lecture's **scheduled start** |
| Automatic ABSENT eligibility | the lecture's **scheduled start**, and the student must also be **enrolled at the scheduled start** |
| QR scan eligibility | the **server-recorded scan time** |
| Online join eligibility | the **server-recorded join time** |
| Historical online backfill | the **recorded join time** |
| Historical "any moment" questions | `approvalDuring` (information only) |

- Only `APPROVED` qualifies automatically (`isAutomaticallyEligible`).
- `UNKNOWN` never qualifies automatically and never creates an automatic
  ABSENT: it goes to the teacher for review (`needsManualApprovalReview`).
- `NOT_APPROVED` is excluded from automatic decisions.
- Times are server-recorded real UTC instants; client-supplied times are
  never used.

### Configuration: `APPROVAL_FEATURE_STARTED_AT`

A **required** per-environment setting: the instant approval enforcement
started in that environment (when commit `e8a9242` was deployed there).

- **Format:** an ISO 8601 instant with an explicit offset:
  `YYYY-MM-DDTHH:MM[:SS[.mmm]]` followed by `Z` or `±HH:MM` (for example
  `+05:30`). Offsets from `-14:00` to `+14:00` inclusive; `Z` and `+00:00`
  are UTC; `-00:00` ("offset unknown") is refused. Values without an offset
  and impossible dates are refused.
- **No default and no fallback.** `approvalHistoryContextFromSetting(raw)`
  turns the raw setting into the `context`; a missing, malformed or impossible
  value throws. Its error messages name the setting, never the value. Do not
  log the value or return it from an API.
- **Choosing the value** (per environment, by the operator; never invented):
  - preferably the recorded deployment time of `e8a9242`;
  - otherwise a value that is certainly **not earlier** than the real go-live,
    for example the earliest `Student.confirmedAt` / `Student.approvedAt` in
    that database (read-only query, with approval), fixed once. A later value
    is safe (more UNKNOWN); an earlier one is not (it would turn unknown
    periods into PENDING).
  - `_prisma_migrations.finished_at` of the approval migrations is only a
    lower bound (when the columns existed, not when the code went live), and
    is meaningless on a database whose migrations were applied in one batch.
- **Where it is supplied:** nothing in the application calls
  `approvalDuring` or `approvalAt` yet. Its future callers (Stage 5: attendance eligibility,
  finalization and backfill) must read the setting on the server, call
  `approvalHistoryContextFromSetting`, and refuse to run (not fall back) if it
  throws. Tests use their own fixed test value.

## Migration

`prisma/migrations/20261110130000_add_student_confirmation_history/migration.sql`:
the `StudentConfirmationSource` enum, the table, the
`(studentId, decidedAt)` index, RESTRICT foreign keys to Student and Teacher,
and, hand-written (MANUAL):

- `CHECK ("fromStatus" <> "toStatus")`
- `CHECK ("toStatus" <> 'PENDING')`
- `CHECK (("source" = 'BULK') = ("batchId" IS NOT NULL))`
- `CHECK ("source" <> 'BULK' OR ("fromStatus" = 'PENDING' AND "toStatus" = 'APPROVED'))`
- `CHECK ("previousConfirmedAt" IS NULL OR "previousConfirmedAt" < "decidedAt")`
- an append-only trigger that refuses `UPDATE`, `DELETE` and `TRUNCATE`.

No existing table, column or row changes; nothing is backfilled.
`tests/students/confirmation-history-migration-guard.test.cjs` fails if the
hand-written parts are lost or altered.

### Applying the migrations on Neon testing

**The migration must be applied before this code runs against a database**:
the code writes `StudentConfirmationHistory` on every decision, so approvals
fail on a database without the table.

Applying migrations is a **separate operation that needs explicit approval**
each time. Nothing in this document runs it, and nothing here applies to
production, which needs its own review and approval afterwards.

#### Direct connection only

- Prisma Migrate (`prisma migrate status` and `prisma migrate deploy`) must
  use Neon's **direct, non-pooled** connection.
- The **pooled** connection (the host containing `-pooler`; PgBouncer in
  transaction mode) must **not** be used for Prisma Migrate. Migrate relies on
  a session-level advisory lock, which a transaction-mode pooler does not keep
  on one server connection. The application itself keeps using the pooled
  connection.
- The project's `.env` currently holds the **pooled** connection, so running
  the migration commands as they are would use it. **Do not edit `.env`** for
  this, and do not copy its value anywhere.
- Take the direct connection string from the Neon console for the testing
  project (its connection details with connection pooling turned off). For
  the migration commands only, provide it as `DATABASE_URL` in the shell
  session that runs them: a variable already set in the environment takes
  precedence over `.env`. Never write the connection string into a file in
  the repository, a commit, or a document.

#### Order

Pending migrations are applied in name order, both by the same
`migrate deploy`:

1. `20261110120000_add_lecture_end_date` (see
   [lecture-end-date.md](lecture-end-date.md))
2. `20261110130000_add_student_confirmation_history`

The Stage 3 and Stage 4 code needs both.

#### Steps (each run only with approval)

1. `npx prisma generate`: regenerates the client from `schema.prisma`; it
   does not connect to any database.
2. **Check the target before anything else.** `npx prisma migrate status`
   prints the database and host it connects to, then the migration state.
   - The host must be the Neon **testing** project's endpoint, **without**
     `-pooler`. Anything else (the pooled host, the Contabo production
     server, an unknown host): stop.
   - The pending migrations must be exactly the two above, in that order (or
     only the second, if the first was applied earlier), with no failed or
     unexpected migration in the history. Otherwise: stop.
3. `npx prisma migrate deploy`, in the same shell session (same direct
   connection, same target).
4. `npx prisma migrate status` again: the database is up to date.
5. Verify the schema (read-only queries):

   ```sql
   -- Lecture end time constraint (1 row)
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = '"Lecture"'::regclass AND conname = 'Lecture_endDate_after_date';

   -- History CHECK constraints (5 rows)
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = '"StudentConfirmationHistory"'::regclass AND contype = 'c';

   -- Foreign keys (2 rows, both ON DELETE RESTRICT)
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = '"StudentConfirmationHistory"'::regclass AND contype = 'f';

   -- Indexes: the primary key and (studentId, decidedAt)
   SELECT indexname, indexdef FROM pg_indexes
   WHERE tablename = 'StudentConfirmationHistory';

   -- Triggers: StudentConfirmationHistory_no_update_delete, StudentConfirmationHistory_no_truncate
   SELECT tgname FROM pg_trigger
   WHERE tgrelid = '"StudentConfirmationHistory"'::regclass AND NOT tgisinternal;
   ```

**Never use `prisma db push`**: it creates neither the CHECK constraints nor
the trigger.

#### Testing on Neon (the agreed approach)

No additional local or throwaway databases are created for this project.
Changes are verified by:

1. controlled testing on the Neon testing database, after the migration has
   been applied with approval;
2. the schema, constraint, index and trigger checks above;
3. where appropriate, application checks run inside transactions that are
   rolled back, so they leave no data behind (each with approval).

## Tests

- `npm run test:confirmation`: decisions and concurrency (in-memory lock
  model), `approvalDuring`, the migration guard, the routes and import
  validation. No database.
- `npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/student-confirmation-actions.test.tsx`
  (also in `npm run test:ui`): the list's decision actions and popovers. No
  database.

### Optional real-database tests (not part of the approved workflow)

`npm run test:confirmation-db` (`tests/students/confirmation-history.db.test.cjs`)
and `npm run test:session-start-db`
(`tests/attendance/session-start-lock.db.test.cjs`) exercise the row locks
against a real PostgreSQL.

- They are **optional** and **not part of the current approved workflow**.
  Do not run them as part of Stage 3/4 verification.
- They need a separate local PostgreSQL database, which this project does not
  create. Their own file headers still describe such a setup; that is not an
  instruction to create one.
- Without `CONFIRMATION_TEST_DATABASE_URL` / `SESSION_START_TEST_DATABASE_URL`
  they skip themselves. They refuse any host other than `localhost` /
  `127.0.0.1`, so they cannot run against Neon or production.
- `test:confirmation-db` disables the history table's append-only trigger
  during its clean-up: never adapt it to a shared database.
