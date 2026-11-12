# Unified lecture attendance

Stages 5.2–5.4. This document describes the **database foundation** (Stage
5.2: five tables, six enums and their constraints), the **pure business
rules** (Stage 5.3, `lib/attendance/`) and the **core services** (Stage 5.4,
in progress: so far configuration, error codes, lock helpers, register
initialization, the read-only register view, evidence processing,
attendance history, manual decisions, lecture schedule synchronization,
online reconciliation, historical backfill (with an operator CLI) and the
read-only gap report) and the read-only finalization preview with its
fingerprint (Stage 5.5a), the finalization transaction (Stage 5.5b), the
teacher API routes (Stage 5.5c, "Attendance API", plus the overview route
of Stage 5.5d-5a) and the teacher UI (Stage 5.5d, "Teacher attendance
UI": the overview, the register page, reconciliation, finalization and the
sidebar item), then Stage 5.6: the teacher decision and evidence review
routes, the history routes, and their UI (manual decision and review
dialogs, student history and register history), and the grace period
(Stage 5.7b-2b: the class default and the per-lecture change). The backfill and the gap report have no API route or UI; the
backfill is reachable only from its operator CLI, which has not been run
against any database.

Migration: `prisma/migrations/20261110140000_add_lecture_attendance/migration.sql`
(follows `20261110130000_add_student_confirmation_history`). **Applied to the
Neon testing database on 2026-11-10. Not applied to production.**

Migration: `prisma/migrations/20261110150000_add_lecture_qr_attendance_closure/migration.sql`
(Stage 5.4b correction: one new table, `LectureQrAttendanceClosure`).
- **Neon testing (`neondb`): applied and structurally verified** (triggers,
  foreign keys and RESTRICT delete behaviour checked).
- **Production: not applied or verified.**

## Purpose

One **canonical attendance record per student per lecture**, fed by three
kinds of evidence:

- **Online:** visits to the lecture's Jitsi sessions (the existing
  `Attendance` rows; one row per visit).
- **Physical:** the owning teacher scanning the student's QR code.
- **Manual:** teacher decisions.

The teacher reviews conflicting evidence and then **finalizes** the register,
which creates ABSENT records for eligible students without one.

### What does not change

- The existing `Attendance` table: no column, index or row changes. (Prisma
  gains a relation list, `Attendance.lectureAttendanceAudits`, that adds
  nothing to the table.) Online joins and leaves write it exactly as before.
- Every existing attendance percentage keeps reading `Attendance`, unchanged.
  A new percentage rule (PRESENT and LATE attended; EXCUSED left out of the
  denominator) is a later, separately approved change.
- `StudentConfirmationHistory`, fee waivers, lectures and sessions.
- Finalization never changes `Lecture.classStatus` (so it never affects fee
  waivers).

## Changes to existing tables (the only two)

| Table | Change |
|---|---|
| `Class` | `attendanceGraceMinutes INTEGER NOT NULL DEFAULT 10`, CHECK 0–240. A constant default: existing rows get 10 without a table rewrite. |
| `Lecture` | Unique index `Lecture_id_classId_key` on `("id", "classId")`. `id` is already unique, so this always succeeds; it is the target of the composite foreign keys that stop an attendance row naming a lecture of another class. Lectures never change class. |

## Enums

| Enum | Values |
|---|---|
| `LectureAttendanceStatus` | `PRESENT`, `LATE`, `ABSENT`, `EXCUSED` |
| `AttendanceStatusSource` | `AUTO` (evidence), `TEACHER`, `FINALIZATION` (ABSENT), `BACKFILL` (PRESENT only) |
| `AttendanceScanResult` | `VALID`, `INVALID_QR`, `QR_UNVERIFIABLE`, `WRONG_TEACHER`, `NOT_ELIGIBLE`, `ELIGIBILITY_UNKNOWN`, `LECTURE_UNAVAILABLE` |
| `AttendanceScanEffect` | `STATUS_UPDATED`, `EVIDENCE_ONLY`, `REVIEW_REQUIRED`, `DUPLICATE`, `RECORDED_ONLY`, `NONE` |
| `AttendanceAuditAction` | `CREATED_AUTO`, `AUTO_UPDATED`, `AUTO_RECALCULATED`, `EVIDENCE_RECORDED`, `TEACHER_SET`, `EVIDENCE_ACCEPTED`, `EVIDENCE_DISMISSED`, `FINALIZE_ABSENT`, `BACKFILL` |
| `RegisterAuditAction` | `CREATED`, `GRACE_CHANGED`, `SCHEDULE_SYNCED`, `FINALIZED` |

## Tables

### `LectureAttendanceRegister` (one per lecture)

Primary key `lectureId` (**one register per lecture**). Created when first
needed; copies the lecture's `date` / `endDate` into `scheduledStartAt` /
`scheduledEndAt` and the class's grace period into `graceMinutes` (the
class's value at creation; later class-default changes never reach an
existing register). While open, the grace period can change (the teacher's
per-lecture change, "Grace period") and the schedule follows lecture edits. Once
`finalizedAt` is set it is **frozen**: it keeps the schedule attendance was
judged against, and cannot be reopened (v1).

- Relations: `(lectureId, classId)` → `Lecture(id, classId)`; `classId` →
  `Class`; `finalizedByTeacherId` → `Teacher`.
- Unique `(lectureId, classId)` (target of the records' composite key); index
  `(classId, finalizedAt)`.

### `LectureAttendance` (one per student per lecture)

Unique `(lectureId, studentId)`: **one canonical record per student per
lecture**.

- `status` is the effective status; `statusSource` says where it came from.
- Evidence: `firstOnlineAt`, `firstQrAt` (each set once, the earliest) and
  `autoStatus` (PRESENT or LATE from the earliest evidence against the
  register's start plus grace).
- Teacher decision: `teacherStatus`, `teacherDecidedAt`,
  `teacherDecidedById`. A teacher decision always wins over evidence.
- `pendingReviewSince`: evidence the teacher should look at.
- `version`: bumped on every change (optimistic checks; one audit row per
  version).
- Relations: `(lectureId, classId)` → the register (so a record always belongs
  to its lecture's register and class); `classId` → `Class`; `studentId` →
  `Student`; `teacherDecidedById` → `Teacher`.
- Indexes: `(classId, studentId)`, `(studentId, lectureId)`,
  `(lectureId, status)`, `(lectureId, pendingReviewSince)`.

### `AttendanceScanEvent` (append-only)

Every QR scan submission, valid or not. Duplicate scans are **events**, never
duplicate records.

- `(scannedByTeacherId, clientScanId)` is unique: the scanner's retry key, so
  a resubmitted scan returns the stored outcome instead of a second event.
- `result`, `effect`, `afterFinalization`, `receivedAt` (server time),
  `clientScannedAt` (informational only).
- `eligibilityReason`: the `approvalAt` reason behind the eligibility decision
  (see `docs/student-confirmation-history.md`); null when no student was
  identified.
- Identity: `studentId`, `qrTokenId`, `scannedTokenHash` (SHA-256 hex).
  **Never** stored for another teacher's student.
- Relations: `(lectureId, classId)` → `Lecture`; `classSessionId` →
  `ClassSession`; `scannedByTeacherId` → `Teacher`; `qrTokenId` →
  `StudentQrToken`; `studentId` → `Student`; `lectureAttendanceId` →
  `LectureAttendance`.
- Indexes: `(lectureId, receivedAt)`, `(studentId, lectureId, receivedAt)`.

### `AttendanceAuditLog` (append-only)

One row per record version: unique `(lectureAttendanceId, version)`. The full
before and after of `status`, `teacherStatus` and `autoStatus`, the actor, an
optional reason, and links to what caused it: `scanEventId`,
`attendanceVisitId` (the `Attendance` visit) or `registerAuditId` (a register
recalculation). Indexes `(lectureId, createdAt)`, `(studentId, createdAt)`.

### `LectureAttendanceRegisterAuditLog` (append-only)

One row per register version: unique `(lectureId, version)`. `CREATED`,
`GRACE_CHANGED`, `SCHEDULE_SYNCED` (with before / after values) and
`FINALIZED` (with the finalization counts). Index `(lectureId, createdAt)`.

## Foreign keys

All 18 are `ON DELETE RESTRICT ON UPDATE CASCADE`: nothing referenced by
attendance can be deleted from under it. (No code hard-deletes students,
teachers, lectures, sessions, QR tokens or visits; lectures are soft-deleted.
Ids never change, so the `ON UPDATE CASCADE` never fires.)

## CHECK constraints (39, hand-written)

A CHECK passes when its expression is NULL, so every rule that compares a
nullable column spells out `IS NOT NULL`.

**`Class`** (1)
- `Class_attendanceGraceMinutes_check`: grace 0–240.

**`LectureAttendanceRegister`** (4)
- `…_graceMinutes_check`: grace 0–240.
- `…_schedule_check`: `scheduledEndAt IS NULL OR scheduledEndAt > scheduledStartAt`.
- `…_finalized_check`: `finalizedAt` and `finalizedByTeacherId` are set together.
- `…_version_check`: `version >= 1`.

**`LectureAttendance`** (9)
- `…_teacher_status_check`: a teacher decision is the effective status.
- `…_auto_status_check`: evidence yields PRESENT or LATE only.
- `…_evidence_check`: `autoStatus` exists exactly when there is evidence (`firstOnlineAt` or `firstQrAt`).
- `…_teacher_decision_check`: a teacher decision records when and by whom.
- `…_source_teacher_check`: source `TEACHER` **exactly** when there is a
  teacher decision (`(statusSource = 'TEACHER') = (teacherStatus IS NOT NULL)`),
  so a decided record is never shown as AUTO, FINALIZATION or BACKFILL.
- `…_source_finalization_check`: `FINALIZATION` ⇒ `ABSENT`.
- `…_source_auto_check`: `AUTO` ⇒ evidence exists (`autoStatus IS NOT NULL`)
  and the status is PRESENT or LATE. It is deliberately **not**
  `status = autoStatus`: after finalization, later evidence (for example an
  earlier online visit added by reconciliation) updates `autoStatus` and
  raises a review, but the status itself is never changed automatically.
  Before finalization, the service keeps `status = autoStatus` for AUTO rows.
- `…_source_backfill_check`: `BACKFILL` ⇒ `PRESENT` (never retroactive LATE).
- `…_version_check`: `version >= 1`.

**`AttendanceScanEvent`** (9)
- `…_record_link_check`: linked to a record exactly when the effect is
  `STATUS_UPDATED`, `EVIDENCE_ONLY`, `REVIEW_REQUIRED` or `DUPLICATE`.
- `…_effect_check`: only a `VALID` scan has an effect other than `NONE`.
- `…_identity_check`: `VALID`, `NOT_ELIGIBLE` and `ELIGIBILITY_UNKNOWN` keep
  `studentId`, `qrTokenId` and `scannedTokenHash` (all three are known: such
  a scan is found by the hash of its token).
- `…_wrong_teacher_check`: `WRONG_TEACHER` keeps no `studentId`, `qrTokenId`
  or `scannedTokenHash`.
- `…_token_hash_check`: `scannedTokenHash` is a 64-character lowercase hex digest.
- `…_eligibility_reason_check`: `eligibilityReason` is null or one of the
  seven `approvalAt` reasons (`KNOWN_APPROVED`, `APPROVED_AT_EVIDENCE`,
  `KNOWN_NOT_APPROVED`, `BEFORE_APPROVAL_FEATURE`, `BEFORE_RECORDED_DECISIONS`,
  `APPROVED_AT_CONFLICT`, `BROKEN_HISTORY`).
- `…_valid_reason_check`: `VALID` requires an **approved** reason
  (`KNOWN_APPROVED` or `APPROVED_AT_EVIDENCE`: the only reasons with which
  `approvalAt` returns APPROVED).
- `…_unknown_reason_check`: `ELIGIBILITY_UNKNOWN` requires an **unknown**
  reason (`BEFORE_APPROVAL_FEATURE`, `BEFORE_RECORDED_DECISIONS`,
  `APPROVED_AT_CONFLICT`, `BROKEN_HISTORY`: the only reasons with which
  `approvalAt` returns UNKNOWN).
- `…_reason_identity_check`: no reason without an identified student.

`NOT_ELIGIBLE` is not tied to a reason: a student who is approved but not
enrolled at the scan time is NOT_ELIGIBLE with an approved reason.

**`AttendanceAuditLog`** (9)
- `…_actor_role_check`: `TEACHER` or `SYSTEM`.
- `…_teacher_action_check`: the actor is `TEACHER` exactly for `TEACHER_SET`,
  `EVIDENCE_ACCEPTED`, `EVIDENCE_DISMISSED`; every other action is `SYSTEM`.
- `…_actor_id_check`: a teacher row names its teacher and a system row names
  nobody (`(actorRole = 'TEACHER') = (actorId IS NOT NULL)`).
- `…_reason_check`: a **reason is required** for `TEACHER_SET` /
  `EVIDENCE_ACCEPTED` that override an existing status (`fromStatus IS NOT
  NULL`) or happen after finalization; the first manual mark needs none.
- `…_version_check`: `version >= 1`.
- `…_creation_check`: version 1 (the record's creation) exactly when there is
  no previous status; version 1 also has no previous teacher or evidence
  status. Every later version has a previous status.
- `…_creation_action_check`: `CREATED_AUTO`, `BACKFILL` and `FINALIZE_ABSENT`
  only ever create a record (version 1); a creation is one of those or a
  teacher's first manual mark (`TEACHER_SET`). All other actions
  (`AUTO_UPDATED`, `AUTO_RECALCULATED`, `EVIDENCE_RECORDED`,
  `EVIDENCE_ACCEPTED`, `EVIDENCE_DISMISSED`) change an existing record.
- `…_finalize_absent_check`: `FINALIZE_ABSENT` ⇒ `toStatus = ABSENT`.
- `…_backfill_check`: `BACKFILL` ⇒ `toStatus = PRESENT`.

**`LectureAttendanceRegisterAuditLog`** (7)
- `…_version_check`: `version >= 1`.
- `…_actor_role_check`: `TEACHER` or `SYSTEM`.
- `…_actor_id_check`: a teacher row names its teacher and a system row names
  nobody (`(actorRole = 'TEACHER') = (actorId IS NOT NULL)`).
- `…_created_check`: `CREATED` ⇒ version 1 and no "from" values.
- `…_grace_changed_check`: both grace values set and different.
- `…_schedule_synced_check`: the start or the end actually changed.
- `…_finalized_check`: `finalizedAt`, the eligible / unknown-eligibility /
  ABSENT counts and `actorId` are set (so, with the actor rule, a teacher
  finalizes).

## Triggers (hand-written)

| Trigger | Timing and event | Effect |
|---|---|---|
| `LectureAttendanceRegister_freeze` | `BEFORE UPDATE OR DELETE`, per row | Refuses every DELETE (open or finalized), and every UPDATE once `finalizedAt` is set. Setting `finalizedAt` itself is allowed (the old row is not finalized yet). |
| `LectureAttendanceRegister_no_truncate` | `BEFORE TRUNCATE`, per statement | Refuses TRUNCATE (an intentional extra safeguard). |
| `<table>_no_update_delete` on `AttendanceScanEvent`, `AttendanceAuditLog`, `LectureAttendanceRegisterAuditLog` | `BEFORE UPDATE OR DELETE`, per row | Append-only (`AttendanceAppendOnly_guard`). |
| `<table>_no_truncate` on the same three tables | `BEFORE TRUNCATE`, per statement | Append-only. |

`LectureAttendance` itself stays updatable (status changes after
finalization are allowed with a reason, and are audited).

Consequence for tests and tooling: these rows cannot be cleaned up with
`deleteMany`. Database checks run inside transactions that are rolled back.

## Database-enforced vs application-enforced

**Enforced by the database** (cannot be broken by any code path): one
register per lecture; one record per student per lecture; the scan retry key;
gap-free unique audit versions; every reference (RESTRICT foreign keys); a
register, record or scan always naming its lecture's real class (composite
`(lectureId, classId)` keys); the 39 CHECK constraints above; the register
freeze; append-only scan events and audit logs.

**Enforced by the application** (services in later substages, with tests):

- *Cross-row consistency* (deliberately not composite foreign keys): a scan's
  `lectureAttendanceId` is the record of the same lecture and student; its
  `qrTokenId` belongs to its `studentId`; its `classSessionId` belongs to its
  lecture; an audit row's `lectureId` / `studentId` match its record, and its
  `scanEventId`, `attendanceVisitId` (a visit of that student in a session of
  that lecture) and `registerAuditId` belong to the same lecture.
- *Ownership:* the student belongs to the class's teacher and is (or was)
  enrolled; the scanning, deciding and finalizing teacher and every teacher
  `actorId` is the class owner.
- *Versions:* an audit row's version equals the record's (or register's) new
  version.
- *Copies:* the register's schedule comes from the lecture, its grace from the
  class.
- *Truthful flags and times:* `afterFinalization`, `pendingReviewSince`,
  server-recorded `receivedAt` / evidence times, earliest evidence only.
- *Scan classification:* `WRONG_TEACHER` (including another teacher's revoked
  token, which is stored with no identity), `INVALID_QR`, `DUPLICATE`,
  `RECORDED_ONLY`, and the `clientScanId` format.
- *Business rules:* eligibility (approval and enrolment at the lecture start
  for automatic ABSENT; approval at the scan / join time for evidence; UNKNOWN
  never qualifies), lateness, the review rule, "only the owning teacher
  scans", finalization conditions (no active session, end time passed or
  lecture COMPLETED), ABSENT only from finalization, the lock order, AUTO
  status equal to the evidence status while the register is open, and that a
  reason is not blank.

## Business rules in the pure helpers (Stage 5.3)

`lib/attendance/` holds the business rules as pure functions (no database,
clock or environment); the services of later substages call them under the
locks. Summary of the rules that go beyond the tables above:

- **Eligibility** (`attendanceEligibilityAt`): ELIGIBLE only when the student
  is active, known to be approved (`approvalAt`) and enrolled at the instant.
  UNKNOWN approval is never eligible. A valid `APPROVAL_FEATURE_STARTED_AT`
  context is required; there is no fallback.
- **Enrolment at the evidence time.** For QR and online evidence, approval
  **and enrolment** are evaluated at the server-recorded scan / join time,
  not "enrolled at some point during the lecture". A student removed at
  18:05 and scanned at 18:20 is NOT_ELIGIBLE; a student added after the start
  but before the scan is eligible for that evidence (but not for an automatic
  ABSENT, which uses the scheduled start). Enrolment rows use
  `ClassStudent.assignedAt` (inclusive) to `removedAt` (exclusive), converted
  from Sri Lankan wall-clock digits; re-enrolment is a separate row.
- **Lateness:** PRESENT up to and including scheduled start + grace, LATE
  after. Only server-recorded times are used, and evidence later than the
  supplied server time is refused.
- **Review rule.** Evidence never changes a teacher decision or a status on a
  finalized register; it raises a review when it is stronger than the
  effective status (PRESENT > LATE > ABSENT = EXCUSED). When reconciliation
  moves an **existing** channel's earliest time earlier, the evidence must
  also be stronger than what that channel already showed, so a dismissed
  review is not recreated by the same information. A new channel follows the
  review table alone. An open review keeps its original `pendingReviewSince`.
- **BACKFILL exception (PRESENT-only).** A `BACKFILL` record stays PRESENT:
  evidence never changes it automatically, even on an open register (the
  general rule "open register, no teacher decision, eligible: the status
  follows the evidence" applies to `AUTO` records only), so backfill is never
  turned into a retroactive LATE. PRESENT is the strongest status, so evidence
  never raises a review on it; only a teacher can change it.
- **Finalization** (`finalizationReadiness`): refused before the scheduled
  start (`LECTURE_NOT_STARTED`), even for a COMPLETED lecture, because
  eligibility is judged at the scheduled start; allowed from the start
  instant when the scheduled end has passed (from the end instant itself) or
  the lecture is COMPLETED; a lecture without an end time needs COMPLETED.
  The service must additionally refuse while any session is active.
- **Automatic ABSENT** is planned only by `planFinalizationAbsences`, which
  always evaluates eligibility at the register's scheduled start: ELIGIBLE
  students without a record become ABSENT; UNKNOWN students are listed for
  manual review and never become ABSENT automatically.

## Core services (Stage 5.4)

Stage 5.4a adds the foundation: configuration, error codes, lock helpers,
register initialization and the read-only register view. Stage 5.4b adds
evidence processing: QR scans, online evidence after the visit's own
transaction, and review accept / dismiss. Manual teacher decisions, grace
changes, lecture hooks, reconciliation, finalization and backfill are later
sub-stages (5.4c-5.4e, 5.4f-1 reconciliation, 5.4f-2 historical backfill and
5.4f-3 the gap report are now done; finalization remains).

### Configuration

Two independent per-environment settings, both an ISO 8601 instant with an
explicit `Z` or `±HH:MM` offset (the same strict format and parser as
`APPROVAL_FEATURE_STARTED_AT` in `docs/student-confirmation-history.md`).
Each is **OK**, **MISSING** (unset or blank) or **INVALID**. There are no
defaults and no fallback instants; an unavailable setting disables what
depends on it. Values never appear in errors, logs or responses: only the
setting's name and status (`lib/attendance/config.ts`).

- `APPROVAL_FEATURE_STARTED_AT` (A): needed wherever approval history is
  evaluated.
- `ATTENDANCE_EVIDENCE_STARTED_AT` (E): when automatic evidence went live.
  A lecture whose start (the open register's current `scheduledStartAt`, or
  `Lecture.date` before a register exists) is at or after E is **LIVE**:
  automatic online evidence and reconciliation, normal rules. Before E it is
  **HISTORICAL**: no automatic evidence; operator backfill (PRESENT only).
  A finalized register keeps its frozen schedule, and so its classification.
  Set E once at go-live; never remove it or move it earlier (that would
  reclassify past lectures).

| Operation | A | E | When a needed setting is unavailable |
|---|---|---|---|
| Register GET | – | – | Always answers, read only. Without A: roster eligibility, the ABSENT preview and the online-evidence check are null. Without E: classification and the online-evidence check are null. |
| Register initialization | – | – | Copies the lecture's schedule and the class's grace (only inside a write that is itself allowed). |
| Manual decisions | – | – | Ownership and enrolment history only. |
| Manual decisions (`setTeacherAttendanceStatus`) | – | – | |
| Accept / dismiss evidence | – | – | |
| Close QR attendance | – | – | |
| Register grace / class-default grace | – | – | |
| QR scan | ✓ | ✓ | 503 (also without `STUDENT_QR_SECRET`); nothing recorded. |
| Online evidence | ✓ | ✓ | Skipped (the join is unaffected). |
| Reconciliation | ✓ | ✓ | 503. |
| Gap report | ✓ | ✓ | 503 (nothing read). |
| Finalization preview (Stage 5.5a) | ✓ | ✓ | 503 (nothing read). |
| Finalization confirm (Stage 5.5b) | ✓ | ✓ | 503 (no transaction). |
| Historical backfill | ✓ | ✓ | 503. |

`ATTENDANCE_APPROVAL_NOT_CONFIGURED` and `ATTENDANCE_EVIDENCE_NOT_CONFIGURED`
are the two 503 codes; `details` carries `{ setting, status }` only.

### Error codes

`lib/attendance/service-errors.ts` holds one table: 400 `VALIDATION_ERROR`,
`ATTENDANCE_REASON_REQUIRED`; 404 `LECTURE_NOT_FOUND`, `STUDENT_NOT_FOUND`;
409 `ATTENDANCE_BUSY` (lock timeout, deadlock or serialization failure: retry),
`ATTENDANCE_RECORD_CHANGED`, `ATTENDANCE_REGISTER_CHANGED`,
`ATTENDANCE_REGISTER_FINALIZED`, `ATTENDANCE_NO_PENDING_REVIEW`,
`FINALIZATION_NOT_ALLOWED`, `FINALIZATION_SESSION_ACTIVE`,
`FINALIZATION_PREVIEW_STALE`, `FINALIZATION_EVIDENCE_PENDING`,
`LECTURE_ATTENDANCE_FINALIZED`, `LECTURE_CANCELLED`,
`ATTENDANCE_LECTURE_HISTORICAL`, `ATTENDANCE_LECTURE_LIVE` (backfill of a
LIVE lecture), `FINALIZATION_ROSTER_LIMIT_EXCEEDED`,
`FINALIZATION_CANDIDATES_CHANGED`, `ATTENDANCE_SCAN_ID_REUSED`; 500
`FINALIZATION_INTEGRITY_ERROR`; 503 the two
configuration codes and `STUDENT_QR_NOT_CONFIGURED`. The QR window adds 409
`ATTENDANCE_QR_NOT_OPEN` (with `details.opensAt`) and `ATTENDANCE_QR_CLOSED`.
Manual decisions add 409 `ATTENDANCE_STUDENT_NOT_ENROLLED` (a student who has
never been enrolled in the class).

### Locking

`lib/attendance/locks.ts`. Every attendance transaction
(`runAttendanceTransaction`) runs at READ COMMITTED (the database default,
never overridden), starts with `SET LOCAL lock_timeout = '3000ms'`, and uses
`{ maxWait: 5000, timeout: 15000 }`. A lock timeout, deadlock or
serialization failure becomes 409 `ATTENDANCE_BUSY`; the whole transaction
rolls back on any error.

Global lock order (a path takes a subset, in this order):

1. Student `FOR SHARE` (evidence paths, finalization's candidate set, and,
   since Stage 5.6a, teacher decisions and review answers; conflicts with a
   student approval decision's `FOR NO KEY UPDATE` and with every `UPDATE`
   of the row, such as a deactivation or deletion).
2. Lecture `FOR SHARE` (finalization, register creation) or
   `FOR NO KEY UPDATE` (lecture edits, status changes, deletion).
3. Class `FOR KEY SHARE`, explicitly, before inserts that reference the
   class. Fee-waiver rule edits hold Class `FOR UPDATE`
   (`services/class-fee-waiver-rule-service.ts`); attendance then waits
   briefly (or gets 409 on timeout), and a rule edit can wait for an
   in-flight attendance transaction, as it already does for session starts
   and enrolments. That transaction locks nothing else, so no cycle is
   possible; fee-waiver behaviour is unchanged.
4. Register `FOR KEY SHARE` (evidence, teacher actions) or `FOR UPDATE`
   (finalization, grace and schedule changes), or its own insert.
5. `LectureAttendance` rows `FOR NO KEY UPDATE`, in ascending `studentId`.
6. Inserts and audit rows.

`AttendanceLocks` enforces this at run time and throws
`AttendanceLockOrderError` (a programming error) before sending a statement
that would break it: a lower level after a higher one, a second row of a
single-row level, records out of order, a lock upgrade (two upgraders
deadlock), or a lock after writes began. Re-locking a held row in an equal or
weaker mode is allowed (it cannot wait); a request that finds no row holds
nothing. All lock statements are static, parameterised `SELECT ... FOR ...`
queries; raw writes send timestamps as UTC ISO text converted explicitly
(`CAST(... AS timestamptz) AT TIME ZONE 'UTC'`).

**Write phase (enforced).** Callers never see the raw transaction: it is kept
in a module-private `WeakMap`. `locks.db` exposes the Prisma models but no raw
SQL (`$queryRaw`, `$executeRaw`, … are refused), refuses every model write
until `locks.beginWrites()`, and refuses anything else (fail closed); after
`beginWrites()` every lock request is refused. The only writes before it are
the module's lock-phase inserts, each inserting the very row the transaction
then holds: a new register with its `CREATED` audit
(`insertRegisterIfAbsent`) and a new record (`insertRecordIfAbsent`; a
concurrent creator makes it re-lock the committed row — the same student
again is allowed — and plan again). Only `runAttendanceTransaction` can create
`AttendanceLocks` (private constructor, module-private token); a test factory
refuses a top-level Prisma client.

**Database errors** are never caught inside a transaction: a failed
statement aborts it and nothing more may be sent. They propagate, the
transaction rolls back, and only then are lock errors mapped (409
`ATTENDANCE_BUSY`) or a scan's unique-key clash answered with the stored
scan. Transaction bodies contain no `try` / `catch` (a guard test checks).

### Register initialization (`ensureRegister`)

Inside an attendance transaction:

1. **always** (the fast path for an existing register included) the Lecture
   `FOR SHARE` and the Class `FOR KEY SHARE`, re-checked under the lock: 404
   when missing, soft-deleted or (given a teacher) another teacher's; 409
   `LECTURE_CANCELLED` when cancelled. An earlier, unlocked read is never
   trusted for a write (`requireLectureForAttendance`;
   `inspectLectureForAttendance` reports the state without throwing);
2. the register `FOR KEY SHARE` / `FOR UPDATE`; when there is none,
   `INSERT ... ON CONFLICT ("lectureId") DO NOTHING` (version 1; the
   lecture's start and end; the class's grace) and, only when this
   transaction inserted it, its `CREATED` audit (version 1, `SYSTEM` or the
   teacher) in the same transaction; then the register in the requested mode.

A concurrent creator waits on the unique key (bounded by the lock timeout),
inserts nothing and locks the committed row: one register, one `CREATED`
audit. The Lecture `FOR SHARE` stops a lecture edit from committing between
the schedule read and the insert.

### Register view (`getRegister`)

Read only: no transaction, no locks, no writes, whatever the configuration.
404 unless the lecture exists (status 0) in one of the teacher's classes.
Without a register row it returns a **computed** register (the lecture's
schedule and the class's grace, `exists: false`, version 0); the row is
created only by a write that needs it.

Candidates are every student of the teacher with any enrolment row in the
class (removed ones included) plus every student with a record. The view
returns the lecture, the register, the configuration status, the
classification, the roster (eligibility and the absence decision at the
scheduled start), the records, the review queue, the ABSENT preview, the
online-evidence check, the active sessions and the finalization readiness
(plus whether finalization is configured: both settings).

**Online-evidence check** (`evidenceRepresentation`; finalization will refuse
with `FINALIZATION_EVIDENCE_PENDING` while it reports anything). V is a
student's earliest visit that was eligible at its own join time:

- LIVE: represented when a record exists and `firstOnlineAt <= V`.
- HISTORICAL: represented when a record exists and its source is `TEACHER`
  or `BACKFILL`, or `firstOnlineAt <= V`.
- A student with no record and a visit whose eligibility was UNKNOWN at its
  join time is reported for teacher review (never ABSENT automatically); a
  teacher decision resolves it.
- Visits that were NOT_ELIGIBLE at their join time are not evidence.

### Evidence processing (Stage 5.4b)

`services/lecture-attendance-evidence-service.ts` (shared evidence code,
online evidence, review), `services/lecture-attendance-qr-service.ts` (QR
scans; separate so the online-join path never loads the server-only QR token
module) and `services/attendance-evidence-dispatcher.ts`.

Every write: one `runAttendanceTransaction`, the global lock order, the
lecture re-checked under its lock, eligibility (approval **and** enrolment) at
the exact server-recorded evidence time, `planEvidence` for the record, then
the write phase. Client times are never used or stored
(`clientScannedAt` stays null).

**QR scan** (`recordQrScan`), needs both settings and `STUDENT_QR_SECRET`
(503 otherwise, nothing recorded):

1. Before any transaction: input checks (`clientScanId`: 16–64 characters of
   `[A-Za-z0-9_-]`); the teacher owns the lecture (404, nothing recorded);
   who the payload identifies (read only); the retry key: a stored scan with
   this `clientScanId` is returned as it is (`replayed: true`), or 409
   `ATTENDANCE_SCAN_ID_REUSED` when it was a different scan (other lecture
   or token).
2. One transaction: the Student `FOR SHARE` (this teacher's own student
   only) with its token re-checked under that lock (a revocation or deletion
   in between makes it `INVALID_QR`); the Lecture and Class, re-checked
   (deleted or cancelled: `LECTURE_UNAVAILABLE`); the register `FOR KEY
   SHARE` if it exists; a **HISTORICAL** lecture is refused with 409
   `ATTENDANCE_LECTURE_HISTORICAL` and nothing is recorded; the register
   held `FOR KEY SHARE` (created when needed), then the **QR window** (see
   "QR scanning window and closure"): 409 `ATTENDANCE_QR_CLOSED` or
   `ATTENDANCE_QR_NOT_OPEN`, nothing recorded; token problems
   (`WRONG_TEACHER`, `INVALID_QR`, `QR_UNVERIFIABLE`); eligibility at
   `receivedAt` (`NOT_ELIGIBLE`, `ELIGIBILITY_UNKNOWN`: a scan event only);
   for `VALID`: the record, the scan event, the audit row (`scanEventId`).
3. A concurrent identical submission loses on the unique key; its
   transaction rolls back, and only then is the stored outcome returned.

Identity kept on scan events: another teacher's token (revoked or not) keeps
no student, token or hash; `QR_UNVERIFIABLE` keeps the token and hash but no
student; an unknown token keeps only its hash; a malformed payload keeps
nothing. Scans are not linked to a class session yet (`classSessionId`
null): linking would take a foreign-key lock on a `ClassSession` row, which
the breakout session end locks `FOR UPDATE`.

**Online evidence** (`recordOnlineEvidence(visitId)`): runs **after** the
visit's own transaction committed, in its own transaction; never touches the
`Attendance` row. Skipped (nothing read or written) without both settings,
for a visit of a session without a lecture, and for unknown visits; inside
the transaction skipped for deleted or cancelled lectures (U8), another
teacher's student, and **HISTORICAL** lectures (R5). UNKNOWN or NOT_ELIGIBLE
at `joinedAt`: nothing written. Otherwise the register, the record and the
audit row (`attendanceVisitId`).

**Dispatch from the join** (`markAttendanceOnJoin`): one call,
`dispatchOnlineEvidence(attendance.id)`, after the visit's transaction and
after its event; the transaction, response and events are byte-for-byte
unchanged (a guard test checks hashes recorded before the change). The call
never throws and starts nothing in the request's own call stack (the queue
starts on a later event-loop turn). Per process: at most 2 evidence
transactions at once and 200 queued visits; overflow, errors and process
restarts are logged (sanitized) and left for reconciliation (Stage 5.4f),
which re-derives evidence from the committed visits. Not run at all on
Netlify / AWS Lambda (a frozen background promise could hold row locks) or
without both settings. No Redis or other infrastructure.

**Review** (`acceptEvidence`, `dismissEvidence`), needs no settings: the
lecture re-checked under its lock (404 deleted or another teacher's, 409
`LECTURE_CANCELLED`); `expectedVersion` must match (409
`ATTENDANCE_RECORD_CHANGED`); a pending review must exist (409
`ATTENDANCE_NO_PENDING_REVIEW`). Accept makes the evidence status the
teacher's decision (source `TEACHER`) and **always needs a reason** (it
replaces an existing status); dismiss keeps the status, reason optional.
Both clear the review and write one audit row (`TEACHER`, after finalization
flagged). Reasons are trimmed, at most 500 characters; blank means none.
Since Stage 5.6a the review transaction first locks the Student row `FOR
SHARE` and, after the lecture checks, requires the teacher's own **active**
student (`Student.status = 0`): another teacher's, an inactive or a deleted
student is 404 `STUDENT_NOT_FOUND`, even on the teacher's own lecture (see
"Teacher decision and review routes").

### QR scanning window and closure (Stage 5.4b correction)

- **Opens** exactly 30 minutes before the scheduled start
  (`qrScanOpensAt`, `QR_SCAN_OPENS_MINUTES_BEFORE_START`). The start is the
  register's `scheduledStartAt`: the authoritative schedule (frozen once
  finalized; otherwise kept in step with the lecture by the schedule sync,
  Stage 5.4e), the same start PRESENT / LATE uses. A scan received (server time)
  before that is refused with 409 `ATTENDANCE_QR_NOT_OPEN` (`details.opensAt`)
  and nothing is recorded.
- **Stays open until the teacher closes it** (`closeQrAttendance`). The
  scheduled end never closes it: a scan after the end is accepted (LATE by the
  grace rule). After the closure every new scan is refused with 409
  `ATTENDANCE_QR_CLOSED` and nothing is recorded; a retry of an earlier scan
  (same `clientScanId`) still returns its stored outcome.
- **PRESENT / LATE is unchanged**: decided by the grace period from the
  register's start (PRESENT up to start + grace, LATE after).
- **Closure** (`closeQrAttendance`): the lecture's teacher only (404 another
  teacher's or a deleted lecture; 409 `LECTURE_CANCELLED`); no settings
  needed; before or after finalization. One transaction: the Lecture `FOR
  SHARE`, the Class `FOR KEY SHARE`, the register `FOR UPDATE` (created when
  needed), then one row in `LectureQrAttendanceClosure` (`closedAt`: server
  time, `closedByTeacherId`). A retry or a concurrent closure finds the row
  and returns it (`alreadyClosed: true`) without writing. **No reopening**:
  there is no reopen operation and the row is append-only in the database
  (`LectureQrAttendanceClosure_no_update_delete`, `_no_truncate`, reusing
  `AttendanceAppendOnly_guard`).
- **Why a separate table** (not register columns, not a register audit row):
  a finalized register is frozen by its trigger, and register audit versions
  follow the register's own version, but closing must stay possible after
  finalization (scans continue as recorded-only / review evidence until
  closed). The closure row is written once and never changes, so it is both
  the state and its audit record (who, when).
- **Concurrency**: every accepted scan holds the register `FOR KEY SHARE`
  while it checks the closure; the closure holds it `FOR UPDATE` (which
  conflicts). A scan that got the lock first commits before the closure can
  proceed; a scan that gets it after a closure committed sees it and is
  refused. The closure is read and written only through `lib/attendance/locks.ts`
  (`readQrClosure` requires the register lock, `insertQrClosure` the write
  phase and the register `FOR UPDATE`).
- Foreign keys: `(lectureId, classId)` → `LectureAttendanceRegister`
  `(lectureId, classId)` and `closedByTeacherId` → `Teacher`, both
  `ON DELETE RESTRICT`. The primary key `lectureId` is the only index
  needed (every read is by lecture).

### Attendance history (Stage 5.4c)

`services/lecture-attendance-history-service.ts`, read only (plain reads: no
transaction, no locks, no writes; no configuration needed). A GET never
creates a register or a record and never touches the append-only audit
tables.

- `getRegisterHistory(teacherId, lectureId, { cursor, limit })`: the
  register's audit log (`CREATED`, `GRACE_CHANGED`, `SCHEDULE_SYNCED`,
  `FINALIZED`, with their before / after values and counts), plus the QR
  closure (`qrClosure`: when and by whom; its own immutable row). No register
  yet: `registerExists: false`, no entries.
- `getStudentAttendanceHistory(teacherId, lectureId, studentId, { cursor, limit })`:
  one student's record audit log (status, teacher status and evidence status
  before / after, actor, reason, after finalization, and the cause: `QR_SCAN`,
  `ONLINE_VISIT`, `REGISTER_CHANGE` or none), plus the record's current
  status. No record: `recordExists: false`, no entries.
- **Order**: by the audit `version` (gap-free and unique per register /
  record, assigned in commit order under the row locks), oldest first. Not by
  `createdAt`, which can tie or be skewed between processes.
- **Pagination**: keyset, `version > cursor`; the cursor is the last version
  of the previous page (decimal string, no leading zeros), `nextCursor` is
  null on the last page. Append-only rows cannot shift between requests, so
  pages never overlap or skip. `limit` 1–100, default 50.
- **Access**: 404 `LECTURE_NOT_FOUND` unless the lecture (status 0) is the
  teacher's; 404 `STUDENT_NOT_FOUND` unless the student is the teacher's
  (ownership only: the teacher's inactive or deleted students stay
  readable); 400 `VALIDATION_ERROR` (`details.field`) for a bad cursor,
  limit or id. Exposed through the Stage 5.6b history routes.
- **Sanitized**: no audit row ids, no scan / visit / register-audit ids, no
  token hashes; actors are `SYSTEM` or the lecture's teacher (id only).

### Manual decisions (Stage 5.4d)

`setTeacherAttendanceStatus({ teacherId, lectureId, studentId, status,
expectedVersion, reason })` in `services/lecture-attendance-decision-service.ts`.

- **Who**: the lecture's teacher only (404 another teacher's or a deleted
  lecture; 409 `LECTURE_CANCELLED`), for their own **active** student (404
  `STUDENT_NOT_FOUND`, also for an inactive or deleted student since Stage
  5.6a) who has an enrolment row in the class, current or
  removed (409 `ATTENDANCE_STUDENT_NOT_ENROLLED` otherwise). Automatic
  eligibility does not matter: UNKNOWN and NOT_APPROVED students can be
  marked. No approval history is read and nothing about eligibility changes;
  no configuration is needed.
- **Status**: `PRESENT`, `LATE`, `ABSENT` or `EXCUSED` (400 otherwise).
- **Reason**: none for the first mark; required to replace an existing
  status (an automatic, backfilled or finalization status included) and for
  any decision after finalization (the database's
  `AttendanceAuditLog_reason_check`; this includes a first mark after
  finalization). Trimmed, non-blank, at most 500 characters (400
  `ATTENDANCE_REASON_REQUIRED` / `VALIDATION_ERROR`).
- **Effect**: the decision becomes the effective status (source `TEACHER`,
  with who and when) and clears a pending review. Recorded evidence (first
  online / QR times, the evidence status) is kept. Later evidence never
  changes the decision: stronger evidence raises a review (accept / dismiss),
  weaker evidence is only recorded. Deciding the status already decided is a
  no-op (no write, no audit); a pending review is answered with accept /
  dismiss.
- **Concurrency**: `expectedVersion` is the record version the teacher saw
  (`null`: no record yet); anything else, including a record created
  concurrently by evidence or another decision, is 409
  `ATTENDANCE_RECORD_CHANGED`.
- **Transaction**: the Student `FOR SHARE` (Stage 5.6a: the owner and
  active check is made on this locked row, after the lecture checks, and
  holds until commit), the Lecture `FOR SHARE` and Class `FOR KEY SHARE`
  (re-checked), the enrolment read, the register `FOR KEY
  SHARE` (created when needed, never modified: a finalized register keeps
  its frozen schedule), the record `FOR NO KEY UPDATE` or its lock-phase
  insert, then the record change and its `TEACHER_SET` audit row (one
  transaction: both or neither). Eligibility and approval history are
  still not read. Exposed by the Stage 5.6a decision route.

### Schedule synchronization (Stage 5.4e)

`updateLectureForTeacher` (`services/lecture-service.ts`), with the helpers
`prepareRegisterScheduleSync`, `applyRegisterScheduleSync`,
`planAutoStatusRecalculation` and `recalculateAutoStatusesInTransaction`
(`services/lecture-attendance-service.ts`).

- **Schedule edits** (start and / or end in the request) run in one
  attendance transaction (3 s lock timeout: 409 `ATTENDANCE_BUSY` when
  attendance work holds the lecture longer):
  1. the Lecture `FOR NO KEY UPDATE` (conflicts with the `FOR SHARE` every
     scan, online-evidence, decision and closure transaction holds), then
     ownership, existence and soft delete re-checked under the lock (404),
     and the new start / end re-checked against the **locked** stored values
     (400, same messages as before);
  2. an existing register `FOR UPDATE` (no register is ever created by an
     edit) and, when it is open and the start moves, its records with
     evidence in `studentId` order;
  3. write phase: the Lecture update, then, for an **open** register whose
     start or end actually changes: its new start / end (the register's own
     grace is never changed), version + 1, and a `SCHEDULE_SYNCED` register
     audit (the editing teacher; before / after; `recalculatedCount`). When
     the start moved, each record whose evidence status changes under the new
     start (stored first online / QR times, the register's grace) gets
     version + 1 and an `AUTO_RECALCULATED` audit (`SYSTEM`, linked to the
     register audit): `AUTO` records follow the new evidence status; `TEACHER`
     and `BACKFILL` records keep their status and teacher decision (only the
     evidence status changes). Pending reviews are kept; rescheduling raises
     no review.
  A **finalized** register is left exactly as it is (register, records,
  audits; the freeze trigger would refuse any change): the lecture still
  changes, the register keeps the schedule attendance was judged against.
- **Title-only edits** keep the existing autocommit update (no transaction,
  no register change). Same-value schedule edits change nothing in the
  register.
- **Stale registers** (an open register whose copy differs from the lecture,
  e.g. created before this stage) are brought in step by the lecture's next
  schedule edit; there is no bulk resync.
- **Classification** follows the register's start, so a schedule edit across
  `ATTENDANCE_EVIDENCE_STARTED_AT` reclassifies an open lecture; existing
  records are never removed.
- **Finalized-lecture protection**: cancelling (`CANCELLED`) or soft-deleting
  a lecture runs in an attendance transaction: the Lecture `FOR NO KEY
  UPDATE` (ownership re-checked), an existing register `FOR KEY SHARE`; a
  finalized register means 409 `LECTURE_ATTENDANCE_FINALIZED` and nothing
  changes. Marking a lecture `COMPLETED` keeps the existing path.
- The fee-waiver hooks run after the commit exactly as before.

### Grace period (Stage 5.7b-2b)

PRESENT / LATE is decided against the grace period stored in the lecture's
**register** (`LectureAttendanceRegister.graceMinutes`), never against a live
class setting once a register exists.

**Class default** (`Class.attendanceGraceMinutes`, whole minutes 0–240, CHECK
`Class_attendanceGraceMinutes_check`; 0 is valid):

- Set in the class create / edit forms through `POST /api/classes` and
  `PUT /api/classes/[id]` (`lib/class-validation.ts`,
  `services/class-service.ts`). Validation: a number only (no string
  coercion, no null), integer, 0–240; omitted on create → **10**; omitted on
  update → unchanged. Only the owning teacher (the existing `teacherId`
  filter; another teacher's class is 404 `CLASS_NOT_FOUND`); the teacher
  comes from the session. Both routes now run `checkSameOriginRequest`
  **before** authentication (403 `CROSS_ORIGIN_REQUEST_REJECTED`). The class
  objects are not strict (the forms also send `startDate`); the field itself
  is. Create, update and list responses include the value.
- It is copied into a register only when the register is **created**
  (`ensureRegister`). Changing it writes the Class row only: no existing
  register, record or audit changes, and no attendance audit is written.
  Until a lecture has a register, the read-only views (register GET,
  finalization preview) show the class's current value, as `ensureRegister`
  would copy it.

**Per-lecture change** (`setRegisterGraceMinutes`,
`services/lecture-attendance-grace-service.ts`; route below):

- **Who / when:** the lecture's teacher only (404 another teacher's, deleted
  or unknown lecture); 409 `LECTURE_CANCELLED` for a cancelled lecture; 409
  `ATTENDANCE_REGISTER_FINALIZED` for a finalized register (the freeze
  trigger would also refuse it). HISTORICAL lectures are allowed. No
  attendance setting is needed.
- **Version:** `expectedVersion` is the register version the teacher saw;
  **0 means no register yet** (the register GET's convention). Anything else,
  including a register created concurrently by another transaction, is 409
  `ATTENDANCE_REGISTER_CHANGED`.
- **No-ops** (nothing written, no audit, version unchanged): the value already
  stored; or no register yet and the class default requested (no register
  is created).
- **No register yet and another value:** the register is created from the
  class default (version 1, `CREATED` audit), then changed (version 2,
  `GRACE_CHANGED`).
- **Effective change**, one transaction: the register's `graceMinutes`,
  version + 1 (exactly once), and one `GRACE_CHANGED` register audit (the
  teacher; from / to; the reason; `recalculatedCount`). Then every record
  with evidence is re-judged under the new grace with the schedule sync's
  own helpers (`planAutoStatusRecalculation`,
  `recalculateAutoStatusesInTransaction`): `AUTO` records follow the new
  evidence status; `TEACHER`, `BACKFILL` and `FINALIZATION` records keep their
  status (and any teacher decision), only their evidence status
  (`autoStatus`) changes; pending reviews are neither raised, cleared nor
  changed; each changed record gets version + 1 and one `AUTO_RECALCULATED`
  audit (`SYSTEM`, linked to the `GRACE_CHANGED` audit by `registerAuditId`).
  No evidence event is created and no online visit is touched.
- **Reason:** trimmed, at most 500 characters. **The service decides** whether
  one is required: when the change recalculates at least one existing record
  (400 `ATTENDANCE_REASON_REQUIRED` without one); optional otherwise.
- **Transaction** (`runAttendanceTransaction`: READ COMMITTED, 3 s lock
  timeout → 409 `ATTENDANCE_BUSY`, 5 s / 15 s limits): the Lecture `FOR SHARE`
  and Class `FOR KEY SHARE` (re-checked), the register `FOR UPDATE` (created
  when needed), the records with evidence `FOR NO KEY UPDATE` in `studentId`
  order (`lockRecordsWithEvidence`, shared with schedule sync), then the
  writes. No Student lock. Any failure rolls everything back.
- **Concurrency:** the register `FOR UPDATE` waits for every evidence,
  decision, review, reconciliation and closure transaction holding it `FOR
  KEY SHARE` (and finalization's `FOR UPDATE`), and blocks new ones until it
  commits; evidence recorded afterwards uses the new grace. Grace changes are
  therefore allowed while reconciliation runs. A teacher decision or review
  prepared on a recalculated record gets 409 `ATTENDANCE_RECORD_CHANGED`; a
  finalization preview made before the change is stale (the fingerprint
  covers the grace and the register version). A class-default `UPDATE`
  (`FOR NO KEY UPDATE` on the Class row) does not conflict with Class `FOR KEY
  SHARE`: a register created at the same moment copies whichever value is
  committed.

### Online reconciliation (Stage 5.4f-1)

`reconcileLectureOnlineEvidence({ teacherId, lectureId, cursor?, limit? })`
(`services/lecture-attendance-reconcile-service.ts`) catches up online
evidence the after-commit dispatcher missed (process restart, lock timeout,
dropped hook). It is request-driven only (no sweeper) and not yet exposed by
any API route.

- **Refusals, before any transaction:** both settings required (503); a
  missing / deleted lecture or another teacher's lecture 404; `CANCELLED` 409
  `LECTURE_CANCELLED`; a HISTORICAL lecture (by the register's start, else the
  lecture date) 409 `ATTENDANCE_LECTURE_HISTORICAL`.
- **Pagination:** distinct students with a visit in any of the lecture's
  sessions, in `studentId` order, strictly after `cursor`; `limit` 1-500
  (default 500). `nextCursor` is the last processed student when more remain,
  otherwise `null`.
- **Visit choice:** a student's visits ordered by `joinedAt`, then visit id;
  eligibility is judged at each visit's own `joinedAt`; the first ELIGIBLE
  visit is used (`leftAt` is never read). No eligible visit: counted
  `ineligible` (or `unknown` when any visit was UNKNOWN); nothing is written.
- **One short attendance transaction per student**, in the standard lock order
  (Student `FOR SHARE`, Lecture `FOR SHARE` with ownership and state
  re-checked, Class, Register, record), then the shared evidence path
  (`applyEvidenceInTransaction`, `ONLINE`, evidence time = the visit's
  `joinedAt`, audit linked to the visit). Rules are exactly those of the
  dispatcher: teacher decisions, `BACKFILL` status and pending reviews are
  preserved; stronger evidence on a decided record raises a review.
- **Finalized registers (F7):** only students who already have a record are
  reconciled (review / evidence only); a student without one is counted
  `finalizedWithoutRecord` and no record is ever created.
- **Skips:** deleted or inactive students `inactive`; a student no longer the
  teacher's `skipped`; a student whose lock wait times out `busy` (that
  transaction rolls back; the run continues). A lecture cancelled, deleted or
  moved to HISTORICAL mid-run stops the run with `stoppedBecause:
  "LECTURE_CHANGED"` and a cursor that resumes at the unprocessed student.
- **Idempotent:** evidence already represented counts as `duplicates` and
  writes nothing. `nextCursor` moves past a `busy` student, so continuing the
  same pass does not retry it; a fresh run (no cursor) catches it up.
- **Output:** counts, `lectureId`, `nextCursor`, `stoppedBecause` only; no
  names, visit ids or timestamps; nothing is logged.

### Historical backfill (Stage 5.4f-2)

`backfillLectureAttendance({ lectureId, mode })`
(`services/lecture-attendance-backfill-service.ts`), reached only from the
operator CLI `npm run attendance:backfill` (`scripts/attendance-backfill.ts`,
logic in `scripts/attendance-backfill-cli.ts`). No API route, page or
runtime path imports it (a test enforces this).

- **One lecture at a time.** Refused before any student is read: missing
  settings (503); missing / deleted lecture 404 `LECTURE_NOT_FOUND`; cancelled
  409 `LECTURE_CANCELLED`; finalized register 409
  `ATTENDANCE_REGISTER_FINALIZED`; LIVE lecture (the register's start, else
  the lecture date, at or after E) 409 `ATTENDANCE_LECTURE_LIVE`.
- **Who:** every student with a visit in any session of the lecture
  (batches of 500 in `studentId` order; the whole lecture is processed). The
  visit used is the earliest one ELIGIBLE at its own `joinedAt` (approval from
  the immutable confirmation history and class enrolment, both at that
  instant; ordered by `joinedAt`, then visit id). UNKNOWN and NOT_APPROVED /
  not-enrolled visits are never used (counted `unknown` / `ineligible`);
  deleted or inactive students are counted `inactive`; a student who is not
  the class teacher's is `skipped`.
- **What:** a student with no record gets exactly one record: `statusSource
  BACKFILL`, `status PRESENT` (always), `autoStatus` = PRESENT / LATE of the
  visit's join time against the register's start + grace (for the teacher's
  information; `createdLateJoin` counts the LATE ones), `firstOnlineAt` = that
  `joinedAt`, no QR / teacher / review fields, version 1; and a `BACKFILL` v1
  audit row (`SYSTEM`, no actor id, linked to the visit). A register created
  by the backfill is attributed to `SYSTEM` (its `CREATED` audit).
- **Never overwritten:** an existing record of any source (AUTO, TEACHER,
  BACKFILL, FINALIZATION) is counted `existing` and not touched (teacher
  decisions and pending reviews included). A concurrent creator wins the
  unique key (`insertRecordIfAbsent`, ON CONFLICT DO NOTHING): the backfill
  inserts nothing and counts `existing`. BACKFILL records are never changed
  automatically later (the evidence rules leave them PRESENT, and online
  evidence skips HISTORICAL lectures).
- **Dry run (default):** plain reads, no transaction, no locks, no writes; the
  same decisions, reporting `created` as "would create".
- **Execute:** one short attendance transaction per student in the standard
  lock order (Student `FOR SHARE`, Lecture `FOR SHARE` + Class re-checked,
  register `FOR KEY SHARE` / created, record `FOR NO KEY UPDATE` / inserted,
  then the audit row); 3 s lock timeout. A busy student is rolled back and
  counted `busy`; the lecture continues. A lecture deleted, cancelled,
  finalized or made LIVE mid-run stops it (`stoppedBecause`). Re-running is
  idempotent: nothing is created twice.
- **Output:** counts only (no names, student ids, visit ids or times); the
  service logs nothing.

**Operator CLI.** Exactly one scope: `--lecture=<id>`, `--class=<id>` or
`--before=<ISO instant with Z / ±HH:MM>` (never "all lectures"). Class and
date scopes list the non-deleted, non-cancelled lectures in (date, id) order
and process each on its own: LIVE and finalized lectures are reported as
refused for that lecture and the run continues. Dry run by default
(`--dry-run` may be given explicitly). Execute needs all three of
`--execute`, `--confirm-backfill-historical-attendance` and
`--confirm-database=<name>` equal to the database in `DATABASE_URL`; the
confirmation flags without `--execute` are refused too. Unknown arguments,
repeated flags, several scopes, malformed ids and timestamps without an
explicit offset are usage errors (exit 2) before any database access, and an
unknown argument's value is never echoed. Output: the target as
`host:port/database` (never credentials), lecture ids and counts. Exit codes:
0 done, 1 refused (single lecture) / incomplete (busy, stopped) / failed, 2
usage. Not run against any database yet: running it (dry run included) needs
separate approval.

### Online attendance gap report (Stage 5.4f-3)

`getOnlineAttendanceGapReport({ teacherId, cursor?, limit? }, { env? })`
(`services/lecture-attendance-gap-report-service.ts`). Read only and
request-driven (no worker); not yet exposed by an API route.

- **Fail closed:** both settings required (503, nothing read). `limit` 1-500
  (default 100) and `cursor` validated (400 `VALIDATION_ERROR` with
  `details.field`).
- **Lecture selection** (one query per page, `ORDER BY id`, `limit + 1` rows
  to detect another page): the teacher's lectures (`class.teacherId`), not
  deleted, not `CANCELLED`, and LIVE and open: no register and `date >= E`, or
  an open register (`finalizedAt` null) with `scheduledStartAt >= E` (the same
  rule as `classifyLecture`; re-checked in code). Excluded lectures never take
  a page slot. `nextCursor` is the last lecture id of a full page with more
  after it.
- **Gap calculation**, one lecture at a time (memory bounded by the largest
  lecture): the lecture's visits (`joinedAt`), the teacher's students among
  the visitors, their approval history, their enrolments in the class and
  their records (`statusSource`, `firstOnlineAt`), passed to the existing
  pure `evidenceRepresentation` (the inputs `getRegister` gives it; tests
  check that both agree on the same data). `pendingStudents` and
  `unknownEligibilityStudents` are its `pending` / `unknownVisits`;
  `eligibleStudents` comes from the same helper run with no records (every
  student with an eligible visit is then pending), so no eligibility rule is
  re-implemented; `representedStudents = eligible - pending`. Units are
  students (each counted once, from the earliest visit eligible at its own
  join time); `visits` counts every visit of the teacher's students.
- **Read only:** plain autocommit `findMany` reads; no attendance
  transaction, row lock, register creation, record, audit or review change,
  and no reconciliation or backfill call. Tests run it behind a recorder that
  fails on any non-read call and compare the whole committed state; a static
  guard forbids write, lock and transaction helpers in the source.
- **Output:** per lecture `lectureId`, `visits`, `studentsWithVisits`,
  `eligibleStudents`, `representedStudents`, `pendingStudents`,
  `unknownEligibilityStudents`; page `totals`; `nextCursor`. No names,
  student or visit ids, times or hashes; nothing is logged.

### Finalization preview and fingerprint (Stage 5.5a)

`getLectureAttendanceFinalizationPreview({ teacherId, lectureId }, { env? })`
(`services/lecture-attendance-finalization-preview-service.ts`) and the pure
fingerprint (`lib/attendance/finalization-fingerprint.ts`). Read only;
nothing finalizes yet (Stage 5.5b), and no API route or UI uses it.

- **Reads only through `getRegister`** (plain autocommit reads; never a
  transaction, lock or register creation), so the effective schedule (the
  register's, frozen once finalized; otherwise the lecture's start / end and
  the class's grace, as `ensureRegister` would copy), the classification
  (LIVE or HISTORICAL; both previewable, D2), the candidate roster, the
  absence plan (`planFinalizationAbsences` at the scheduled start), the
  online-evidence check (`evidenceRepresentation`), the review queue, the
  active sessions and `finalizationReadiness` are the register view's own.
  Both settings are required first (503, nothing read); a missing, deleted
  or another teacher's lecture is 404; a cancelled or finalized lecture is
  previewed with its blocker.
- **Summary** (counts only): the roster size; ELIGIBLE / UNKNOWN at the start
  (with or without a record); a partition of the roster, each student once:
  `studentsWithRecord` + `automaticAbsent` (no record, ELIGIBLE) +
  `manualReview` (no record, UNKNOWN: never ABSENT automatically) +
  `notEligibleWithoutRecord` (not approved, not enrolled, removed, inactive or
  deleted at the start); existing records by status (an existing ABSENT record
  is counted there, never as automatic ABSENT).
- **Evidence:** pending eligible online evidence and unknown-approval
  evidence (the `evidenceRepresentation` lists; both must be empty:
  `complete`), and pending teacher reviews (shown, never blocking: D1).
- **Blockers** (`ready` only without any): the `finalizationReadiness` reason
  (`ALREADY_FINALIZED`, `LECTURE_CANCELLED`, `LECTURE_NOT_STARTED`,
  `SCHEDULED_END_NOT_PASSED`, `COMPLETION_REQUIRED`); and, before
  finalization, `SESSION_ACTIVE` (any active session of the lecture, no
  override: D3), `EVIDENCE_PENDING`, `UNKNOWN_EVIDENCE`, and
  `ROSTER_LIMIT_EXCEEDED` (more than 500 candidates: D6). QR closure is not
  required and not read (D7).
- **Fingerprint** (SHA-256, lowercase hex, version 1) over a canonical
  document (an explicit serializer: sorted keys, UTC ISO dates, every list
  sorted by `studentId`, `undefined` / non-finite values refused, duplicate
  students refused, a domain tag hashed first) of: the lecture (id, status,
  `classStatus`, date, end); the register (exists, version, start, end,
  grace, `finalizedAt`); every record (studentId, id, version, status,
  source); every candidate (studentId, absence decision, eligibility outcome,
  reason and approval reason); the pending and unknown evidence (studentId and
  earliest visit time); the classification; the readiness; whether a session
  is active. Not included: names, registration numbers, session / visit ids,
  review timestamps (a review changes the record version), QR closure,
  configuration values. Stage 5.5b recomputes it under its locks and refuses
  a mismatch (409 `FINALIZATION_PREVIEW_STALE`).
- **Output:** counts, the lecture and register schedule, readiness and the
  fingerprint; no names, student, record, session or visit ids. Nothing is
  logged.

**Consistency (D8): the preview is not authoritative.** Its reads are separate
autocommit statements, so a student row, that student's approval history,
the enrolments and the records can come from different snapshots (a decision
or deletion committing between them). A torn read can only change the
preview's numbers and fingerprint; it is never acted on. The Stage 5.5b
confirmation must, inside one attendance transaction:

1. Read the candidate student ids (enrolments of the teacher's students in
   the class plus record holders) and lock **every candidate Student row
   `FOR SHARE` in ascending id, in one statement, as the first step** (level
   1, before the Lecture). A student decision (`FOR NO KEY UPDATE`),
   deactivation or deletion (`UPDATE "Student"`) then cannot commit until
   finalization ends, and one that already committed is fully visible
   (status, `confirmedAt`, `approvedAt` and its history row commit together).
   This needs an approved lock-order extension: today the Student level
   allows one row per transaction.
2. Then the Lecture `FOR SHARE`, Class `FOR KEY SHARE`, register `FOR UPDATE`
   (`ensureRegister`, creating it when needed), the active-session check.
3. Re-read the candidate set under those locks; any candidate not locked in
   step 1 (a new enrolment or record holder) fails closed (409
   `FINALIZATION_PREVIEW_STALE`; nothing written). Enrolments are written at
   the current time, after the scheduled start, so they cannot change
   eligibility at the start; the re-check still refuses a changed roster.
4. Re-read students, approval history, enrolments, records and visits, build
   the same fingerprint input, and compare. Eligibility comes only from
   `planFinalizationAbsences`; a student whose history is inconsistent with
   their row is UNKNOWN (manual review), never ABSENT; a deleted or inactive
   student is not eligible.
5. More than 500 candidates refuses (D6), before any lock wait on students.

### Finalization (Stage 5.5b)

`finalizeLectureAttendance({ teacherId, lectureId, fingerprint }, { env?, now? })`
(`services/lecture-attendance-finalization-service.ts`), with the
finalization-only helpers in `lib/attendance/locks.ts`
(`runFinalizationTransaction`, `lockStudentSetForFinalization`,
`createFinalizationAbsences`). No API route or UI uses it yet. Irreversible
(D9: no reopen; the freeze trigger refuses any change of a finalized register).

**One transaction** (`runFinalizationTransaction`: the attendance
transaction's READ COMMITTED, 3 s lock timeout and 15 s limit, lock errors →
409 `ATTENDANCE_BUSY` after the rollback, plus the finalization scope):

0. Plain reads: the lecture (ownership; 404) and the register (already
   finalized → the idempotent result, without Student locks). The candidate
   ids, sorted: the teacher's students with any enrolment row in the class
   plus every record holder. More than 500 → 409
   `FINALIZATION_ROSTER_LIMIT_EXCEEDED`, before any lock (D6).
1. **Every candidate Student `FOR SHARE`, one statement, ascending id, as the
   first lock** (D8). Fewer rows than ids → 409
   `FINALIZATION_CANDIDATES_CHANGED` (never a skipped student).
2. Lecture `FOR SHARE` and Class `FOR KEY SHARE`, re-checked (404 deleted or
   another teacher's; 409 `LECTURE_CANCELLED`). Session start takes Lecture
   `FOR NO KEY UPDATE`, so no session can start until the commit.
3. Register `FOR UPDATE`: waits for every evidence, QR, decision, review,
   closure, reconciliation and schedule-sync transaction and blocks new ones.
   Finalized meanwhile (a concurrent confirmation) → the idempotent result.
4. The candidate ids again, under the locks: any difference → 409
   `FINALIZATION_CANDIDATES_CHANGED`.
5. Records, enrolments, approval history, visits and active sessions are read
   under the locks; the register view is rebuilt with the same pure helpers as
   `getRegister` (`planFinalizationAbsences` at the register's scheduled
   start, `evidenceRepresentation`, `finalizationReadiness`) and the Stage 5.5a
   `buildFinalizationPreview` computes the same summary, blockers and
   fingerprint.
6. Blockers: readiness → 409 `FINALIZATION_NOT_ALLOWED` (`details.reason`);
   an active session → 409 `FINALIZATION_SESSION_ACTIVE` (D3); pending or
   unknown-approval evidence → 409 `FINALIZATION_EVIDENCE_PENDING` (counts in
   `details`); more than 500 → 409 `FINALIZATION_ROSTER_LIMIT_EXCEEDED`.
   Pending reviews never block (D1), nor do UNKNOWN students without
   unknown evidence (they stay without a record: manual review).
7. The recomputed fingerprint must equal the client's, else 409
   `FINALIZATION_PREVIEW_STALE`. No write happens before this point.
8. Writes: a missing register is created (`insertRegisterIfAbsent`, TEACHER;
   if another transaction created it meanwhile: finalized → idempotent
   result, otherwise `FINALIZATION_PREVIEW_STALE`); then the write phase: the
   ABSENT records of exactly the plan's `CREATE_ABSENT` students
   (`createFinalizationAbsences`: one `createMany` without
   `skipDuplicates`, ascending, 1–500 rows, the count checked; ABSENT,
   source FINALIZATION, no evidence, no teacher decision, version 1); the
   register (`finalizedAt`, `finalizedByTeacherId`, version + 1; schedule and
   grace unchanged); its `FINALIZED` audit (TEACHER, `eligibleCount`,
   `unknownEligibilityCount`, `absentCreatedCount` from the plan); one
   `FINALIZE_ABSENT` audit per new record (SYSTEM, version 1, linked to the
   FINALIZED audit by `registerAuditId`). `Lecture.classStatus`, existing
   records, teacher decisions and reviews are never written. Any failure
   rolls everything back.

**Why the Student locks protect eligibility (D8).** Approval history is
written only by `decideStudentConfirmation` and `confirmAllPendingStudents`
(`services/student-service.ts`), each of which first locks the Student row
`FOR NO KEY UPDATE` and writes the status, `confirmedAt` / `approvedAt` and
the history row in that one transaction; deactivation and deletion are
`UPDATE "Student"` statements (an implicit row lock). All conflict with `FOR
SHARE`, so while finalization holds the candidates' rows none of them can
commit, and one that committed earlier is fully visible to the reads under
the locks. Enrolments are written with the current time (after the scheduled
start, which readiness requires), so they cannot change eligibility at the
start; a new candidate is caught by the re-read in step 4. Every other
`UPDATE "Student"` (profile, password, login) also waits while finalization
holds the row (at most the 15 s transaction limit). Lock order with the
other Student lockers: the bulk approval locks students in ascending id too;
evidence paths, teacher decisions and review answers take one Student `FOR
SHARE` first (compatible); no path holds a Lecture, Class or Register lock
and then waits for a Student, so no cycle.

**Repeated confirmation (D5).** A finalized register returns success with
`alreadyFinalized: true`, the register's `finalizedAt` and version, and the
three counts stored in its `FINALIZED` audit (the other counts are not stored
by the schema: `details: null`). It first checks exactly one FINALIZED
audit whose version, time and teacher equal the register's, and as many
`FINALIZE_ABSENT` audits as it counts; otherwise 500
`FINALIZATION_INTEGRITY_ERROR`. Nothing is written; the client's fingerprint
is not used.

### Stage 5.4f: operational status and limitations

What exists: three service functions (reconciliation, historical backfill,
gap report) and one operator CLI. What does not exist yet: finalization,
any API route or UI for these services, and any background worker (F2:
everything is request- or operator-driven).

- **Not validated on real PostgreSQL.** Every concurrency, lock and race test
  runs against the in-memory model (`tests/attendance/helpers/`). Real
  PostgreSQL concurrency testing remains postponed and is a pre-production
  requirement.
- **The backfill CLI has never been run**, against any database, dry run
  included. Importing `lib/prisma` loads the project `.env`, so even a dry run
  reads whatever database `DATABASE_URL` / `.env` names; each run needs
  separate approval. `--confirm-database` compares the database **name**
  only (as `qr:reissue`), not the host: two servers with the same database
  name are not told apart.
- **Busy students:** reconciliation's `nextCursor` moves past a busy student
  (continuing a pass does not revisit it); a fresh run without a cursor does.
  The backfill counts busy students and a re-run picks them up.
- **Dry run vs execute:** the backfill dry run reads without locks, so its
  counts can differ from a later execute if data changes in between.
- **Visits are read before the per-student transactions** (reconciliation and
  backfill): a visit committed during the run is picked up by the next run
  (or by the dispatcher, for LIVE lectures).
- **Query volume:** the gap report makes up to five reads per lecture with
  visits (a 500-lecture page is ~2,500 sequential reads; the default page is
  100), and its reads are not one snapshot (counts can be momentarily
  inconsistent while evidence is written). Reconciliation and backfill page
  students with Prisma `distinct`, which (without the `nativeDistinct` preview
  feature) de-duplicates in the query engine after reading the lecture's
  matching visit rows.
- **Gap-report units are students** (each counted once, from the earliest
  eligible visit); `visits` is the only per-visit count. HISTORICAL lectures
  are not reported (backfill covers them).
- **Cursors:** reconciliation's cursor is a student id and the gap report's a
  lecture id: opaque continuation keys, never names.

## Attendance API (Stage 5.5c)

Four teacher routes over the existing services (no business logic in the
routes). Route files: `app/api/lectures/[id]/attendance/route.ts`,
`.../attendance/reconcile/route.ts`, `.../attendance/finalization/route.ts`,
`.../attendance/finalize/route.ts`; shared helpers `lib/attendance-http.ts`;
the register contract `lib/attendance-register-response.ts`. The teacher UI
(Stage 5.5d) uses them; the overview route (Stage 5.5d-5a) is described
after the four.

**Common rules.**

- **Authentication:** the middleware (`/api/lectures/:path*`) answers 401
  without a valid session cookie; every route then calls
  `requireTeacherSession()` (401 `UNAUTHORIZED` for no session or a student /
  admin session). The teacher id comes **only** from the session (never from
  the query or body; an unknown body field is rejected).
- **Ownership:** enforced by the services: another teacher's, a missing or a
  deleted lecture is the same 404 `LECTURE_NOT_FOUND` (no existence leak).
- **Lecture id:** trimmed; empty or longer than 191 characters → 400
  `VALIDATION_ERROR` (`details.field: "lectureId"`); no format check (the
  service decides).
- **CSRF:** both POSTs check `checkSameOriginRequest` first (before
  authentication): `Sec-Fetch-Site`, when sent, must be `same-origin`, and
  `Origin` must equal `APP_URL` / `NEXT_PUBLIC_APP_URL` (refused when neither
  is set) → 403 `CROSS_ORIGIN_REQUEST_REJECTED`. GETs follow the lecture GET
  routes (no origin check).
- **Bodies:** JSON with strict schemas; invalid JSON → 400 `INVALID_JSON`;
  schema failures → 400 `VALIDATION_ERROR` with `details.field` (`body` for an
  unknown field or a non-object body); values are never echoed.
- **Responses:** `{ success: true, data }` / `{ success: false, error: {
  message, code, details? } }`; every response (errors included) carries
  `Cache-Control: private, no-store, max-age=0` (plus `Pragma: no-cache`,
  `Expires: 0`, `Vary: Cookie`). Dates are UTC ISO strings.

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` (`details.field`), `INVALID_JSON` |
| 401 | `UNAUTHORIZED` |
| 403 | `CROSS_ORIGIN_REQUEST_REJECTED` (POSTs) |
| 404 | `LECTURE_NOT_FOUND` |
| 409 | `LECTURE_CANCELLED`, `ATTENDANCE_LECTURE_HISTORICAL` (reconcile), `ATTENDANCE_BUSY` (retry), `FINALIZATION_NOT_ALLOWED` (`details.reason`), `FINALIZATION_SESSION_ACTIVE`, `FINALIZATION_EVIDENCE_PENDING` (`details` counts), `FINALIZATION_ROSTER_LIMIT_EXCEEDED` (`details.limit`, `rosterSize`), `FINALIZATION_CANDIDATES_CHANGED`, `FINALIZATION_PREVIEW_STALE` |
| 500 | `FINALIZATION_INTEGRITY_ERROR` (fixed message); anything unexpected `INTERNAL_SERVER_ERROR` (generic message in production, written to the API error log) |
| 503 | `ATTENDANCE_APPROVAL_NOT_CONFIGURED`, `ATTENDANCE_EVIDENCE_NOT_CONFIGURED` (`details: { setting, status }`, never the value) |

### `GET /api/lectures/[id]/attendance`

The register (`getRegister`, read only, never creates a register), through
an explicit field-by-field mapping, never the internal `RegisterView`
(D4). `data`:

- `lecture`: `id`, `classId`, `title`, `classStatus`, `date`, `endDate`.
- `register`: `lectureId`, `exists` (false: computed, nothing stored yet),
  `scheduledStartAt`, `scheduledEndAt`, `graceMinutes`, `version` (0 without
  a register), `finalized`, `finalizedAt`.
- `configuration`: `{ approval, evidence }`, each `OK` / `MISSING` /
  `INVALID`.
- `classification`: `LIVE` / `HISTORICAL` / null.
- `students[]`: `studentId`, `name`, `registrationNumber`, `eligibility` (`{
  outcome, reason, approvalReason }` at the scheduled start, or null),
  `absenceDecision` (`CREATE_ABSENT` / `HAS_RECORD` / `NOT_ELIGIBLE` /
  `MANUAL_REVIEW`, or null), `record` (`{ status, statusSource, autoStatus,
  teacherStatus, firstOnlineAt, firstQrAt, teacherDecidedAt, version }` or
  null; `version` is the decision API's `expectedVersion`), `review: {
  pending, since }`. A record of a student who is not the teacher's (not
  expected) is listed with `name` / `registrationNumber` null.
- `summary`: `students`, `withRecord`, `recordStatus: { PRESENT, LATE,
  ABSENT, EXCUSED }`, `pendingReviews`.
- `absencePreview`: `{ automaticAbsentStudentIds, manualReviewStudentIds,
  eligibleCount, unknownEligibilityCount, absentCreatedCount }` or null.
- `onlineEvidence`: `{ complete, pending: [{ studentId,
  earliestEligibleVisitAt }], unknownVisits: [{ studentId,
  earliestUnknownVisitAt }] }` or null.
- `activeSessions`: `{ active, count }` (no session ids).
- `finalization`: `{ readiness: { allowed, basis | reason }, configured }`.

Never returned: record ids, session ids or start times, the finalizing
teacher's id, `teacherDecidedById`, created / updated timestamps, enrolment
rows, the internal roster / records / review-queue structures (a test walks
every key against an allowlist). **Configuration:** this route never answers
503: without `APPROVAL_FEATURE_STARTED_AT` the `eligibility`,
`absenceDecision`, `absencePreview` and `onlineEvidence` fields are null;
without `ATTENDANCE_EVIDENCE_STARTED_AT` `classification` and
`onlineEvidence` are null; `configuration` says which, and
`finalization.configured` is false. Review reasons are not part of the
register view (they are in the history routes' data, a later stage).

### `POST /api/lectures/[id]/attendance/reconcile`

One page of `reconcileLectureOnlineEvidence` (LIVE lectures; HISTORICAL →
409 `ATTENDANCE_LECTURE_HISTORICAL`). Body (optional; strict): `{ cursor?:
string | null, limit?: integer 1–500 }`; the API's default page is **100**
students (the service's own limits are unchanged); `cursor` must be
non-blank and at most 191 characters. `data` is the service result
unchanged: `lectureId`, `processed`, `applied`, `duplicates`, `ineligible`,
`unknown`, `inactive`, `finalizedWithoutRecord`, `busy`, `skipped`,
`nextCursor`, `stoppedBecause`.

Client workflow: start without a cursor; send `nextCursor` back until it is
null; if any page of the pass reported `busy > 0`, start a fresh pass
without a cursor (the cursor moves past busy students); a page that stopped
with `stoppedBecause: "LECTURE_CHANGED"` resumes from its `nextCursor`.
Repeating a page or a pass is safe (idempotent). Finalization's evidence gate
(`FINALIZATION_EVIDENCE_PENDING`) stays authoritative.

### `GET /api/lectures/[id]/attendance/finalization`

The Stage 5.5a preview unchanged (`lecture`, `register`, `classification`,
`summary`, `evidence`, `readiness` with `blockers`, `fingerprint`,
`fingerprintVersion`); counts only, no student identities. 503 when a setting
is missing or invalid.

### `POST /api/lectures/[id]/attendance/finalize`

Body (strict): `{ fingerprint: string }` from the preview (64 lowercase hex,
else 400 `VALIDATION_ERROR` `details.field: "fingerprint"`). Runs
`finalizeLectureAttendance` (one atomic transaction). `data`: `lectureId`,
`alreadyFinalized`, `finalizedAt`, `registerVersion`, `eligibleStudents`,
`unknownEligibilityStudents`, `absentCreated`, `details` (`{ rosterSize,
studentsWithRecord, manualReview, notEligibleWithoutRecord,
recordStatusBefore, pendingReviews }` for a new finalization; null when it
was already finalized). **200** both for a new finalization and for a repeated
confirmation (`alreadyFinalized: true`, nothing written: D5). A stale
fingerprint is 409 `FINALIZATION_PREVIEW_STALE` (preview again).

**Integrity errors (D3).** `FINALIZATION_INTEGRITY_ERROR` writes exactly one
structured operator line to the server console (stderr, PM2's log):
`{"event":"attendance.finalization.integrity_error","level":"error",
"code":"FINALIZATION_INTEGRITY_ERROR","lectureId",…,"teacherId",…,
"requestId",…,"at",…}` (`requestId` from a safe `x-request-id` header, else
null), nothing else (no details, body, student data, SQL, tokens or
settings), and the client gets the fixed 500 message. It is not also written
by the generic handler; other attendance errors get no new logging.

### `GET /api/lectures/attendance-overview` (Stage 5.5d-5a)

One page of the signed-in teacher's lectures with each attendance register's
state, for the overview page. Read only. Route file
`app/api/lectures/attendance-overview/route.ts` (a static segment: it takes
precedence over `[id]`); service
`services/lecture-attendance-overview-service.ts`
(`listLectureAttendanceOverviewForTeacher`).

- **Lectures:** the existing `listLecturesForTeacher` unchanged: the teacher
  from the session only (401 otherwise), the same ownership, deleted lecture /
  class filtering, filters, sort and pagination as `GET /api/lectures`.
- **Query parameters** (the lecture list's validation):
  - `page`, `pageSize`: positive integers; default 1 and 10, `pageSize` at
    most 100. A missing or invalid value falls back to the default (not 400).
  - `classId`: must be a UUID (else 400 `VALIDATION_ERROR`); another
    teacher's or an unknown class → 404 `CLASS_NOT_FOUND`.
  - `title`: trimmed; case-insensitive "contains".
  - `from`, `to`: instants (ISO); inclusive bounds on the lecture date
    (`gte` / `lte`); an unparseable value → 400 `VALIDATION_ERROR`.
  - `sortOrder`: `asc`; anything else is `desc` (by lecture date).
- **Register data:** read only for the lecture ids of that ownership-checked
  page (never ids from the client), with three bulk queries (registers,
  record counts by status, pending reviews); nothing is evaluated per
  student (no eligibility, readiness or absence preview).
- **`data[]`:** `lectureId`, `title`, `date`, `endDate` (UTC ISO),
  `classStatus` (`SCHEDULED` / `LIVE` / `COMPLETED` / `CANCELLED`), `class: {
  id, name }`, `register` (null when no attendance has been recorded yet, so
  no register exists; otherwise `{ finalized, finalizedAt, version }`),
  `recordStatus: { PRESENT, LATE, ABSENT, EXCUSED }` (0 without a register),
  `pendingReviews`, `classification` (`LIVE` / `HISTORICAL`, the register
  view's rule; null while `ATTENDANCE_EVIDENCE_STARTED_AT` is missing or
  invalid; this route never answers 503 for configuration).
- **`pagination`** (beside `data`): `page`, `pageSize`, `totalItems`,
  `totalPages`, `hasNextPage`, `hasPreviousPage`.
- Always no-store, like the other attendance routes.

### Teacher decision and review routes (Stage 5.6a)

Two POST routes over the existing services (no business logic in the
routes): `app/api/lectures/[id]/attendance/students/[studentId]/decision/route.ts`
and `.../review/route.ts`; shared helpers in `lib/attendance-http.ts`
(`parseStudentId`, `decisionBodySchema`, `reviewBodySchema`,
`decisionResponse`, `reviewResponse`). The common rules of the Stage 5.5c
routes apply: `checkSameOriginRequest` first (403
`CROSS_ORIGIN_REQUEST_REJECTED`, before authentication and before the body
is read), then `requireTeacherSession()` (401); the teacher id comes only
from the session; strict JSON bodies (an unknown field, a `teacherId`
included, is 400 `VALIDATION_ERROR` `details.field: "body"`; invalid or empty
JSON is 400 `INVALID_JSON`); both ids trimmed, non-empty, at most 191
characters (400 `details.field: "lectureId"` / `"studentId"`); explicit
response field lists (the record's row id is never returned); every response
no-store; errors through the shared handler (request-id logging, no server
internals).

**Who may act (enforced in the services, under the transaction).** Both
transactions now take the **Student row `FOR SHARE` first** (the global lock
order puts Student before Lecture; the evidence paths already did), then the
lecture checks (404 `LECTURE_NOT_FOUND` for a missing, deleted or another
teacher's lecture; 409 `LECTURE_CANCELLED`), then the student check on the
locked row: the student must belong to the session's teacher and have
`Student.status = 0`. Another teacher's student, an inactive (`status 1`) or
a deleted (`status 2`) student is the same non-disclosing 404
`STUDENT_NOT_FOUND` as an unknown id, also for a review on the teacher's own
lecture. The lecture's 404 / 409 keep their precedence over the student
check. Because the row stays locked until commit, a deactivation, deletion
or transfer cannot commit in between, and one committed earlier is seen; a
writer already holding the Student row makes the action wait (409
`ATTENDANCE_BUSY` on the 3 s lock timeout). The rest of each transaction
(register, record, version check, reason rule, audit) is unchanged.

#### `POST /api/lectures/[id]/attendance/students/[studentId]/decision`

Body: `{ status: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED", expectedVersion:
integer ≥ 0 | null, reason?: string | null }` (`expectedVersion` is
required). Runs `setTeacherAttendanceStatus` (see "Manual decisions"):

- `expectedVersion` is the record version the teacher saw, `null` when the
  student had no record. Record versions start at 1, so 0 is the service's
  400 (`details.field: "expectedVersion"`). A record that changed since
  (also one created meanwhile by evidence or reconciliation) is 409
  `ATTENDANCE_RECORD_CHANGED`; nothing is retried with another version.
- Reason (trimmed; at most 500 characters, else 400 `VALIDATION_ERROR`
  `details.field: "reason"`): none needed for a first mark on an open
  register; required (400 `ATTENDANCE_REASON_REQUIRED`) to replace an
  existing record's status, even when the chosen value equals the current
  status of an automatic, finalization or backfill record, and for any
  decision on a finalized register, a first mark included. The database's
  `AttendanceAuditLog_reason_check` enforces the same rule.
- Finalized registers: a decision corrects a record after finalization
  (audited with `afterFinalization: true`); the register itself is never
  modified or reopened.
- Re-deciding the status the teacher already decided is a no-op (200,
  `changed: false`, nothing written).
- A never-enrolled student keeps 409 `ATTENDANCE_STUDENT_NOT_ENROLLED`.
- `data`: `{ lectureId, studentId, status, statusSource: "TEACHER",
  teacherStatus, autoStatus, pendingReview, version, afterFinalization,
  changed }`.
- Each applied decision writes one `TEACHER_SET` audit row (from / to status,
  teacher status and evidence status, the teacher, the reason).

#### `POST /api/lectures/[id]/attendance/students/[studentId]/review`

Body: `{ action: "ACCEPT" | "DISMISS", expectedVersion: integer ≥ 0, reason?:
string | null }`. `ACCEPT` runs `acceptEvidence`, `DISMISS` runs
`dismissEvidence` (see "Evidence processing", **Review**):

- A pending review must exist (409 `ATTENDANCE_NO_PENDING_REVIEW`, also
  without a register or record, and for ACCEPT without an evidence status);
  `expectedVersion` must match (409 `ATTENDANCE_RECORD_CHANGED`).
- ACCEPT makes the recorded evidence status (`autoStatus`) the teacher's
  decision (`status` = `teacherStatus` = `autoStatus`, source `TEACHER`) and
  always requires a reason (it replaces an existing status). DISMISS keeps
  the current status and only clears the review; a reason is optional
  (trimmed and checked when given). Both clear `pendingReviewSince` and write
  one audit row (`EVIDENCE_ACCEPTED` / `EVIDENCE_DISMISSED`, actor the
  teacher, `afterFinalization` when the register is finalized).
- Which evidence raises a review is unchanged (`planEvidence`, see "Evidence
  processing"): only eligible evidence that is **stronger** than the
  effective status (PRESENT > LATE > ABSENT = EXCUSED) of a teacher,
  finalization or backfill record, or of any record on a finalized
  register; weaker or equal evidence is only recorded; a duplicate (not
  earlier than the channel's first time) changes nothing; an open review
  keeps its original time; after a dismissal, the same channel raises a
  review again only with genuinely stronger evidence.
- `data`: `{ lectureId, studentId, action, status, statusSource,
  teacherStatus, autoStatus, pendingReview, version }`.

**Concurrency.** Decisions and reviews do **not** take the register UI's
shared reconciliation / finalization lock: they are allowed while
reconciliation runs. If reconciliation (or any evidence) changes the record
first, the teacher's request fails with 409 `ATTENDANCE_RECORD_CHANGED` and
the teacher decides again from the refreshed register. Finalization's
register `FOR UPDATE` still serializes against both (they hold the register
`FOR KEY SHARE`), and a decision or review made after a finalization
preview makes that preview stale (the fingerprint covers decisions).

### History routes (Stage 5.6b)

Two read-only GET routes over the existing history service
(`services/lecture-attendance-history-service.ts`, unchanged): plain reads,
no transaction, no lock, no write; never create a register or a record.
`requireTeacherSession()` (401); no same-origin check (GETs follow the
lecture GET routes); the teacher id comes only from the session (a
`teacherId` query parameter is never read); ids as above; always no-store.

- **Query:** `cursor` (the previous page's `nextCursor`, passed unchanged to
  the service's format check: a positive integer without leading zeros, at
  most 9 digits) and `limit` (decimal digits; 1–100, default 50), each at most
  once. A repeated, blank or malformed value is 400 `VALIDATION_ERROR` with
  `details.field: "cursor"` / `"limit"`; a cursor past the end is an empty
  last page.
- **Pagination:** keyset by the audit `version` (gap-free and unique per
  register / record), oldest first; `nextCursor` is returned exactly as the
  service gives it (null on the last page). Pages are not one snapshot: an
  entry committed after a page was read arrives on a later page; nothing is
  skipped or repeated.
- **Sanitized:** explicit field lists, UTC ISO dates; no audit, scan, visit
  or register-audit row ids, no student names or registration numbers, no
  teacher ids. The actor is `{ role: "TEACHER" | "SYSTEM", isCurrentTeacher
  }` (the service's teacher id is replaced by whether it is the signed-in
  teacher).

#### `GET /api/lectures/[id]/attendance/history`

The **register-level** history (`getRegisterHistory`): `{ lectureId,
registerExists, registerVersion, qrClosure: { closedAt, actor } | null,
entries: [{ version, action: CREATED | GRACE_CHANGED | SCHEDULE_SYNCED |
FINALIZED, at, actor, reason, graceMinutes, scheduledStartAt, scheduledEndAt,
finalization: { finalizedAt, eligibleCount, unknownEligibilityCount,
absentCreatedCount } | null, recalculatedCount }], nextCursor }`. Only the
lecture's teacher (404 `LECTURE_NOT_FOUND` otherwise, before any history is
read). No register yet: `registerExists: false`, no entries. There is no
lecture-wide feed of individual students' record changes.

#### `GET /api/lectures/[id]/attendance/students/[studentId]/history`

One student's **record** history (`getStudentAttendanceHistory`): `{
lectureId, studentId, recordExists, record: { status, statusSource, version,
pendingReview } | null, entries: [{ version, action, at, actor, reason,
afterFinalization, status, teacherStatus, autoStatus (each { from, to }),
cause: QR_SCAN | ONLINE_VISIT | REGISTER_CHANGE | null }], nextCursor }`.
The lecture must be the teacher's (404 `LECTURE_NOT_FOUND`) and the student
must be the teacher's (404 `STUDENT_NOT_FOUND`, the same as an unknown id),
both checked before the record or its audit rows are read; another teacher's
student is refused even when a record of that student exists on the
teacher's lecture. The student check is on ownership only, **not** on
`Student.status`: the history of the teacher's own inactive or deleted
students stays readable (the Stage 5.6a active-student rule applies to
actions only). No record: `recordExists: false`, no entries.

### `POST /api/lectures/[id]/attendance/grace` (Stage 5.7b-2b-2)

Route file `app/api/lectures/[id]/attendance/grace/route.ts` over
`setRegisterGraceMinutes` (see "Grace period"); helpers `graceBodySchema`
and `graceResponse` in `lib/attendance-http.ts`. The Stage 5.5c / 5.6a
conventions: `checkSameOriginRequest` first (403, before authentication and
before the body is read), `requireTeacherSession()` (401), the lecture id
trimmed and at most 191 characters, always no-store.

- **Body** (strict; an unknown field, a `teacherId` included, is 400
  `details.field: "body"`): `{ graceMinutes: integer 0–240, expectedVersion:
  integer ≥ 0, reason?: string | null }`.
- **`data`:** `{ lectureId, graceMinutes, registerVersion, changed,
  registerCreated, recalculatedCount }` (`registerVersion` 0 and `changed:
  false` for a no-op before any register exists). No audit or record ids.
- **Errors:** 400 `VALIDATION_ERROR` (`details.field`), `INVALID_JSON`,
  `ATTENDANCE_REASON_REQUIRED`; 401 `UNAUTHORIZED`; 403
  `CROSS_ORIGIN_REQUEST_REJECTED`; 404 `LECTURE_NOT_FOUND`; 409
  `LECTURE_CANCELLED`, `ATTENDANCE_REGISTER_FINALIZED`,
  `ATTENDANCE_REGISTER_CHANGED`, `ATTENDANCE_BUSY`. No 503 (no attendance
  setting is needed).

## Teacher attendance UI (Stages 5.5d, 5.6 and 5.7b-2b)

Client pages over the API above; the server decides everything (ownership,
eligibility, readiness, blockers, fingerprints). Nothing is stored in the
browser (no localStorage / sessionStorage) and nothing is cached. All dates
are shown in Sri Lankan time (Asia/Colombo). Shared logic:
`components/attendance/attendance-ui.ts` (typed requests that keep the
API's error codes, labels, error messages, the reconciliation loop).

### Navigation

- **Sidebar:** the teacher sidebar (`components/dashboard-shell.tsx`) has an
  **Attendance** item (after Lectures) linking to `/dashboard/attendance`. It
  is active on `/dashboard/attendance` and on every
  `/dashboard/attendance/[lectureId]` register page. This sub-path matching
  (`isNavItemActive`) applies to Attendance only: other items keep exact
  matching, and paths such as `/dashboard/attendance-overview` do not
  activate it. Like the other items, it is locked while the teacher's
  account is pending; the admin sidebar does not have it.
- **Registers:** each lecture in the overview links to its register
  (`/dashboard/attendance/[lectureId]`); the lecture list also has a
  **Register** link per lecture.

### Attendance overview (`/dashboard/attendance`, Stage 5.5d-5b)

`app/dashboard/attendance/page.tsx` (thin wrapper) and
`components/attendance/attendance-overview-panel.tsx`. Read only.

- **Tabs:** **Upcoming** requests `from = now`, oldest first; **Previous**
  requests `to = now − 1 ms`, newest first. The API bounds are inclusive, so
  a lecture at exactly "now" is only in Upcoming. "Now" is read again for
  every request. Changing tab returns to page 1.
- **Filters** (applied with **Apply**, not per keystroke; **Clear filters**
  resets them; both return to page 1): title search; class (the first 50 of
  the teacher's classes from `GET /api/classes`; if that list cannot be
  loaded, only the class filter is disabled); a date range of Sri Lankan
  calendar days (From: 00:00, To: 23:59:59.999, at +05:30, independent of
  the browser's time zone), combined with the tab's bound (the later start
  and the earlier end win).
- **Pagination:** 20 lectures per page, from the API's `pagination` (page X
  of Y, previous / next; disabled while a request is running).
- **Per lecture** (a table on wide screens, cards with the same fields on
  narrow ones; nothing is hidden): title, class, date and time, lecture
  status (a cancelled lecture has a "Cancelled" badge with an icon, not
  colour alone), register state (**No attendance recorded yet** / **Open** /
  **Finalized** with its date), the PRESENT / LATE / ABSENT / EXCUSED counts,
  pending reviews, and an **Open register** link. No page-wide summary cards
  (one page of lectures would make them misleading).
- **States:** loading; refreshing (the current list stays visible); empty
  Upcoming, empty Previous, no matches for the filters; errors through the
  shared helper (signed out → Sign in; network, server, unknown class or
  unexpected response → a message and **Try again**); a notice when every
  lecture on the page has no classification (attendance settings not
  configured).
- **Stale responses:** each new request aborts the previous one, and only
  the newest request may update the page (nothing updates it after unmount).

### Register page (`/dashboard/attendance/[lectureId]`, Stage 5.5d-2)

`components/attendance/lecture-attendance-register-panel.tsx` loads `GET
/api/lectures/[id]/attendance` and shows the lecture and register header,
the backend's summary counts and every student, with search (name /
registration number) and status (including "no record") and review filters
applied to the loaded data. It is the canonical attendance register, not
the session join / leave log on the lecture list. Reconciliation and
finalization share one action lock (never both at once); after either, the
register reloads in place. Stage 5.6 adds per-student actions (Change
status, Accept / Dismiss evidence, View history) and the register history
section (below).

### Reconciliation (Stage 5.5d-3)

"Reconcile online evidence" on the register page (`reconcile-section.tsx`,
`reconciliation-controller.ts`, over the shared `runReconciliation`):

- **Availability** mirrors what the API refuses, so the teacher is told
  before clicking: not for a cancelled lecture, not when attendance settings
  are not configured (no classification), not for a HISTORICAL lecture. On a
  finalized register it is allowed, with a note that it only adds online
  evidence to existing records (and may raise a review), never changes a
  finalized status and never creates records.
- **Run:** pages of 100 students following `nextCursor`; if a pass reported
  busy students, a fresh pass from no cursor after a 1.5 s pause (at most 3
  passes, at most 200 pages per pass). Progress is shown as it arrives; the
  run can be cancelled; a second start while running is ignored.
- **Outcome:** complete, or stopped without claiming completion (busy
  students remaining, the lecture changed, no progress, the safety limit,
  cancelled, or an API error with its code). The register is refreshed after
  an outcome that changed data.

### Finalization (Stage 5.5d-4)

"Preview finalization" on the register page (`finalization-dialog.tsx`,
`finalization-controller.ts`):

- **Preview:** opening the dialog takes the shared action lock and loads a
  fresh preview (`GET .../finalization`); blockers and warnings come from
  the server, each with its own message.
- **Confirm:** only for the latest preview, only when the server reported no
  blockers, only after an explicit "cannot be undone" acknowledgement, one
  submission at a time; it sends exactly that preview's fingerprint (never
  computed in the browser).
- **Failures:** a stale preview (`FINALIZATION_PREVIEW_STALE`,
  `FINALIZATION_CANDIDATES_CHANGED`) locks confirmation until a fresh preview
  is loaded (no automatic retry); a retryable failure (busy, network, server)
  may confirm the same preview again (finalization is idempotent); any other
  refusal locks confirmation until a fresh preview.
- **Result:** a new finalization or `alreadyFinalized` is shown and the
  register reloads in place.
- **Dialog accessibility:** focus is kept inside the dialog and returned on
  close; the rest of the page is made inert while it is open.

### Per-student actions (Stages 5.6d–5.6f)

The register table has an **Actions** column and every student card an
action row with the same actions (desktop and mobile are equivalent; every
existing column, filter, evidence and review field is kept). Each action's
accessible name includes the student's name. Actions are offered only where
the server would accept them:

- **Change status** (5.6d): not on a cancelled lecture, not for a record of
  another teacher's student (shown without a name), not for an inactive
  student (eligibility reason `STUDENT_INACTIVE`), not for an unknown status;
  a short note is shown instead.
- **Accept evidence / Dismiss evidence** (5.6e): only for a pending review,
  with the same exclusions; Accept only when the record has an evidence
  status (else the server refuses it). No review action without a pending
  review.
- **View history** (5.6f): every one of the teacher's own students
  (inactive included; history stays readable on a cancelled lecture); not
  for another teacher's student.

Without attendance settings the inactive state is unknown to the page: the
action is then offered and the server's 404 is the guard.

### Manual decision dialog (Stage 5.6d)

`components/attendance/decision-dialog.tsx`. A snapshot of the student is
taken when the dialog opens (current status, source, the record's version,
whether the register is finalized); its version is the request's
`expectedVersion` (`null` without a record) and is never changed locally.

- Step 1: the current status, a radio group of the **other** statuses (the
  current one is never offered: an unchanged decision is a server no-op), and
  the reason (required / optional, with the reason why: replaces the
  recorded status, finalized register, or optional for a first mark on an
  open register; trimmed character count against the 500 limit). Errors
  (no status, missing or too long reason) are announced and linked to the
  fields (`aria-describedby`, `aria-invalid`). The UX rule mirrors the server
  (`decisionReasonRequirement`, `checkAttendanceReason`); the server stays
  authoritative.
- Step 2: an explicit confirmation ("Change *name* from A to B?" with the
  reason) before **Confirm change**.
- Success: the register reloads from the server (no local change) and the
  dialog closes with a confirmation message. Any 409 (the record changed, or
  the server refused the state): the register is refreshed, the dialog
  explains it and offers only **Close** (the teacher decides again from the
  current register; nothing is retried). Other failures show the shared safe
  message and a manual **Try again** with the same snapshot version.

### Evidence review dialog (Stage 5.6e)

`components/attendance/review-dialog.tsx`. Opened with the chosen action
(Accept or Dismiss) and a snapshot (current status and source, the evidence
status, the record's version). It shows both statuses and explains the
effect: Accept applies the evidence status as the teacher's decision
(reason required); Dismiss keeps the current status and clears the review
(reason optional, trimmed and checked when given). Then an explicit
confirmation. A 409 (`ATTENDANCE_NO_PENDING_REVIEW` /
`ATTENDANCE_RECORD_CHANGED`): "This review changed or is no longer pending",
the register is refreshed, only **Close** is offered. Success refreshes the
register and closes the dialog.

**One action at a time.** Decisions and reviews go through **one**
`createRecordActionController` per register page
(`components/attendance/record-action-controller.ts`): while either is being
sent, or the register is being refreshed after it, the other is refused
(no queue, no duplicate submission); each dialog only calls its own request
(`submitDecision` / `submitReview`) and only shows its own kind of result;
one dialog cannot open over the other. The controller is **not** given the
shared reconciliation / finalization lock, so decisions and reviews stay
possible while reconciliation runs; the server's version check settles any
race. It never retries, never invents or increments a version, refreshes
after a success, a 409 or a cancellation, and is disposed (request aborted,
late answers ignored) on unmount.

### Attendance history (Stage 5.6f)

`components/attendance/history-views.tsx`, read only (no decision or review
action inside). Times are Sri Lankan (`formatColomboDateTime`, now in
`attendance-ui.ts`; the register panel still exports it). Actors are shown as
**You**, **Teacher** (another teacher; not expected under the current
ownership rules) or **System**, from `isCurrentTeacher`; no ids are shown.

- **Student history dialog** (View history): "Attendance history: *name*";
  the current record (status, source, review state) when there is one; the
  entries oldest first: action, time, actor, status change, and, only where
  supplied, teacher status, automatic status, reason, "After finalization"
  and the evidence cause. No record: "no attendance record for this lecture,
  so there is no history yet". Loaded when the dialog opens
  (`createStudentHistoryLoader`) and disposed (request aborted) when it
  closes or the page unmounts. It does **not** refresh by itself while open;
  **Reload** (or reopening) fetches the first page again.
- **Register history section** (below the students, separate from student
  history): collapsed by default ("Show register history", `aria-expanded`);
  the first page loads when first shown and again when the register's
  version changes while it is shown (e.g. after finalization). Entries:
  register created, grace period changes, schedule synchronization (before
  → after times), finalization (time and the eligible, unknown-eligibility
  and marked-absent counts), records recalculated, reasons, actors; and the
  QR closure (time and actor). A QR closure does not change the register
  version, so it appears after **Reload**. No lecture-wide student feed.
- **Paging (both):** "Load more" follows the server's `nextCursor` exactly
  (disabled while a request runs: no concurrent requests; overlapping
  entries are shown once). Initial loading and reloading states are shown; a
  reload keeps the shown entries until the new first page arrives. A failure
  shows the shared safe message and keeps every entry already shown; **Try
  again** repeats exactly the failed request (the same cursor after a failed
  Load more, else the first page). Stale answers are ignored.

### Grace period (Stage 5.7b-2b-3)

- **Class forms** (`components/class-management-panel.tsx`, request bodies
  from `components/class-form-payload.ts`): "Attendance grace period
  (minutes)" in the create and edit forms; a new class starts at 10, an
  existing class shows its saved value (0 included). The value is checked
  before sending (whole minutes 0–240, using `parseGraceMinutesInput`) and
  is always sent as a number; every other field is sent as before. Errors
  use the form's existing message banner.
- **Register** (`components/attendance/grace-dialog.tsx`,
  `grace-controller.ts`): the header shows the register's grace; a
  **Change** action is offered only for a register that is not finalized, on
  a lecture that is not cancelled (historical lectures included). The
  dialog takes a snapshot when it opens (the current grace and the register
  version as loaded: `expectedVersion`, 0 without a register). Step 1: the
  new value (0–240, different from the current one) and an optional reason;
  step 2: an explicit confirmation. **The server decides** whether a reason
  is required: on `ATTENDANCE_REASON_REQUIRED` the dialog returns to step 1
  with the reason marked required, and the teacher resubmits explicitly.
- **After the request** (one at a time; never retried): success refreshes the
  register (its register-history section reloads when the version changes)
  and shows the server's result, "N attendance record(s) were recalculated"
  for an effective change, never for a no-op ("Nothing was changed");
  `ATTENDANCE_REGISTER_CHANGED`, `ATTENDANCE_REGISTER_FINALIZED`,
  `LECTURE_CANCELLED` (and 404) refresh the register, explain it and offer
  only Close (a cancelled lecture's refreshed register no longer shows the
  action); `ATTENDANCE_BUSY`, network and server errors show the shared safe
  message and allow a manual Try again with the same version. A failed
  refresh keeps the register already shown. The controller does not use the
  reconciliation / finalization lock and is disposed (request aborted) on
  unmount.

### Dialog accessibility (Stages 5.5d-4, 5.6d–5.6f, 5.7b-2b-3)

The finalization dialog keeps its own wiring; the decision, review,
student history and grace-period dialogs use `components/attendance/use-modal-dialog.ts`,
which runs the same two utilities in the same order
(`dialog-focus.ts`, `dialog-inert.ts`): on open, focus moves inside (the
`data-autofocus` control: Cancel, Back or Close), then everything outside the
dialog becomes `inert`; Tab / Shift+Tab cycle inside only; Escape closes
except while a request is being sent (the history dialog can always be
closed); on close the background is restored first, then focus returns to
the action that opened it, or to the register's student count line when that
action no longer exists (e.g. filtered out after the refresh). All three are
`role="dialog"` with `aria-modal`, a title and a description (the student's
name), `aria-busy` while busy, and a bottom sheet on narrow screens; while
busy every control is disabled and focus is kept inside the dialog.

### Configuration and limitations

- `APPROVAL_FEATURE_STARTED_AT` and `ATTENDANCE_EVIDENCE_STARTED_AT` (see
  Configuration) are required for eligibility, classification,
  reconciliation and finalization. Without them the register still loads
  (those fields null), the reconciliation and finalization-preview APIs
  answer 503 (the register page already marks reconciliation unavailable
  when there is no classification), and the overview shows the "not
  configured" notice when no lecture on the page has a classification.
- The POST routes (reconcile, finalize) need `APP_URL` /
  `NEXT_PUBLIC_APP_URL` for the same-origin check (refused when neither is
  set).
- The overview's class filter lists the first 50 classes only (as the
  lecture page does). Title search is applied explicitly (no debounce).
- Finalization is limited to 500 students per lecture
  (`FINALIZATION_ROSTER_LIMIT_EXCEEDED`).
- The decision, review and grace POST routes need `APP_URL` /
  `NEXT_PUBLIC_APP_URL` like the other POSTs (same-origin check), and so do
  class create / edit since Stage 5.7b-2b-2 (403 without it).
- No cancel button for a decision or review request in flight (the
  controller supports cancellation; the dialog cannot be closed while busy).
- The student history dialog does not refresh by itself while open
  (Reload or reopen); the register history shows a QR closure, which does
  not change the register version, only after Reload.
- An inactive student is recognized from the register's eligibility; when
  attendance settings are not configured the decision / review actions are
  offered and the server refuses them (404).

### Pre-production validation (outstanding)

- **Real PostgreSQL concurrency and locking:** every concurrency, lock and
  race test runs against the in-memory model; validation on real PostgreSQL
  remains postponed and is required before production. The in-memory tests
  do not prove real PostgreSQL locking behaviour.
- **Browser checks:** the UI tests render with react-dom/server and test the
  controllers without a DOM. Clicking through the sidebar, overview,
  register, reconciliation, finalization, the decision, review and student
  history dialogs and the register history (including focus, inert
  behaviour, the mobile bottom sheets and long histories) in a real browser
  has not been done, nor a screen-reader check.
- **Stage 5.6 under real PostgreSQL:** the decision and review routes' new
  Student `FOR SHARE` lock, their races with reconciliation, finalization
  and student management, and the history routes' paging have only been
  exercised against the in-memory model. None of these workflows has been
  validated in production.
- **Grace period under real PostgreSQL:** the register `FOR UPDATE` against
  concurrent evidence, decisions, reviews, reconciliation and finalization;
  concurrent register creation (`ON CONFLICT DO NOTHING`, then 409); the
  duration of a recalculation on a large register within the 15 s limit;
  a class-default update racing register creation. In-memory tests only so
  far. The class forms and the grace dialog have not been tried in a real
  browser.
- **Known unrelated test failure:** `npm run test:ui` has one failing test
  outside attendance (`tests/ui/screen-share-fps.test.tsx`, the Jitsi
  toolbar "Settings" test), which predates Stage 5.5d; it is a separate
  issue.
- **Production migrations:** `20261110140000_add_lecture_attendance` and
  `20261110150000_add_lecture_qr_attendance_closure` are applied to the Neon
  testing database only (see below).
- **Backfill CLI:** never run against any database (see Stage 5.4f).

## Applying the migration to production (pending; separate approval required)

Status: applied to the Neon testing database on 2026-11-10; **production
has not been migrated.** The later QR-closure migration
(`20261110150000_add_lecture_qr_attendance_closure`) is applied to Neon
testing (`neondb`) and structurally verified (triggers, foreign keys and
RESTRICT delete behaviour); it is not applied to or verified on production.
Production follows the same procedure, and its two foreign keys
briefly take SHARE ROW EXCLUSIVE on `LectureAttendanceRegister` and `Teacher`. The production migration needs its own explicit
approval and follows the same procedure as the testing one
(`docs/student-confirmation-history.md`, "Applying the migrations on Neon
testing"): Prisma Migrate over the target's **direct, non-pooled**
connection only, check the target with `prisma migrate status` first, then
`prisma migrate deploy`; never `prisma db push`. Then run
`npx prisma generate` for the deployed build.

### Locks taken while it runs

Run it while the app is idle (for production: a quiet period). PostgreSQL
behaviour of each step:

| Step | Lock | Effect while held |
|---|---|---|
| `ALTER TABLE "Class" ADD COLUMN … DEFAULT 10` | ACCESS EXCLUSIVE on `Class` | **Reads and writes** of `Class` wait. With a constant default (PostgreSQL 11+) there is no table rewrite. |
| `ADD CONSTRAINT … CHECK` on `Class` | ACCESS EXCLUSIVE on `Class` | Reads and writes wait while every row is checked (all are 10). |
| `CREATE UNIQUE INDEX "Lecture_id_classId_key"` (not concurrent) | SHARE on `Lecture` | Writes to `Lecture` wait while the index is built; reads continue. |
| Each `ADD FOREIGN KEY` | SHARE ROW EXCLUSIVE on the referenced table | Writes to `Class`, `Lecture`, `Teacher`, `Student`, `ClassSession`, `StudentQrToken` and `Attendance` (online joins) wait; reads continue. Checking is instant (the new tables are empty). |
| Creating the new tables, enums, indexes, CHECKs and triggers | On the new tables only | Nothing existing waits. |

**Assumption (not verifiable without a database):** Prisma Migrate sends the
whole script as one multi-statement query, which PostgreSQL runs as one
implicit transaction. Then every lock above is held until the migration ends,
and a failure rolls everything back. If instead each statement committed on
its own, each lock would be released as its statement ends, and a failure
would leave a partial migration (Prisma would mark it failed; resolving it
needs a separate, approved step).

### Lock timeout

The script starts with `SET lock_timeout = '5s'` and ends with
`RESET lock_timeout`:

- every single lock wait is limited to 5 seconds, so the migration **fails**
  instead of waiting indefinitely behind a long transaction (and making every
  later query on that table queue behind it);
- there is no statement timeout, so long-running work isn't cut short;
- it is a **session-level** setting, not `SET LOCAL`: it works whether the
  script runs as one implicit transaction or statement by statement. If the
  script fails inside a transaction, the setting is rolled back with it;
  otherwise `RESET` restores the default for the rest of Prisma's session.

If it fails on the timeout, nothing needs to be undone by hand when the
transaction assumption holds; retry when the app is idle (with approval).

### Read-only checks afterwards

```sql
SELECT conrelid::regclass AS "table", conname, contype
FROM pg_constraint
WHERE conrelid IN ('"LectureAttendanceRegister"'::regclass, '"LectureAttendance"'::regclass,
                   '"AttendanceScanEvent"'::regclass, '"AttendanceAuditLog"'::regclass,
                   '"LectureAttendanceRegisterAuditLog"'::regclass, '"Class"'::regclass)
ORDER BY 1, 2;
-- Expected: 39 CHECK (contype 'c'), 19 FOREIGN KEY ('f'), 6 PRIMARY KEY ('p').
-- The counts include Class's existing Class_pkey and Class_teacherId_fkey.

SELECT tablename, indexname FROM pg_indexes
WHERE tablename IN ('LectureAttendanceRegister', 'LectureAttendance', 'AttendanceScanEvent',
                    'AttendanceAuditLog', 'LectureAttendanceRegisterAuditLog')
   OR indexname = 'Lecture_id_classId_key'
ORDER BY 1, 2;
-- Expected: 21 (5 primary keys, 5 unique, 10 plain on the new tables, plus Lecture_id_classId_key).

SELECT tgrelid::regclass, tgname FROM pg_trigger
WHERE NOT tgisinternal AND tgname LIKE '%Attendance%' ORDER BY 1, 2;
-- Expected: 8 triggers.
```

## Tests

`npm run test:attendance-schema` (also part of `npm run test:attendance`):
the static migration guard
(`tests/attendance/lecture-attendance-migration-guard.test.cjs`). It checks the
enums, tables, the two changes to existing tables, every foreign key (all
RESTRICT), unique keys and indexes, all 39 CHECK constraints verbatim, that the
scan reason rules use exactly `approvalAt`'s APPROVED and UNKNOWN reasons (read
from `lib/student-confirmation-history.ts`), the audit and register audit
rules, the lock timeout (first and last statements, no `SET LOCAL`, no
statement timeout), both trigger functions and all 8 triggers, that nothing is
dropped or backfilled and no timestamp default exists, that no other migration
touches these objects, and that `schema.prisma` matches (including that the
`Attendance` and `StudentConfirmationHistory` columns are unchanged).

`npm run test:attendance-helpers` (also part of `npm run test:attendance`):
the pure helpers (`tests/attendance/attendance-helpers.test.cjs`): enrolment
boundaries and re-enrolment, every approval outcome and the missing context,
grace boundaries, the evidence and review rules (including dismissed reviews
and reconciliation), the BACKFILL exception, future evidence times, and the
finalization start / end boundaries and absence planning.

`npm run test:attendance-service` (also part of `npm run test:attendance`):
the Stage 5.4a foundation (`tests/attendance/attendance-service-foundation.test.cjs`),
with no database: both settings independently OK / MISSING / INVALID, the
strict offset format, that values never reach errors, logs or responses,
the error table, every lock-order rule, the transaction settings,
`ensureRegister` (creation, the creation race with exactly one `CREATED`
audit, rollback, the fee-waiver Class lock, timeouts as 409), and
`getRegister` (read only under a Prisma double that refuses any write,
every degraded configuration, LIVE / HISTORICAL representation, the frozen
finalized schedule).

`npm run test:attendance-evidence` (also part of `npm run test:attendance`):
Stage 5.4b (`tests/attendance/attendance-evidence.test.cjs`), with no
database, against an in-memory PostgreSQL model
(`tests/attendance/helpers/attendance-pg-model.cjs`) that enforces the
record, scan-event and audit CHECK constraints, row locks, unique-key waits,
rollback and aborted transactions: the write-phase guard, lecture
revalidation (cancelled / deleted between reads, a cancel holding the lock),
database errors and lock timeouts inside transactions, QR scans (valid,
LATE boundary, duplicates, retries, reused ids, the race of two identical
submissions, eligibility at the scan time, UNKNOWN, token problems, a token
revoked before the lock, historical lectures, teacher decisions, after
finalization, fail-closed configuration), online evidence (eligibility at
`joinedAt`, skips, combined with QR, a creation race), the dispatcher, the
join hook's hashes, review accept / dismiss, and audit chains.
`tests/attendance/attendance.test.cjs` also runs the real join with the hook:
the evidence starts after the visit committed, a failure never fails the
join, and without the settings nothing is attempted.

`npm run test:attendance-qr-window` (also part of `npm run test:attendance`):
the QR window and closure (`tests/attendance/qr-window-closure.test.cjs`):
exactly 30 minutes before the start, one millisecond earlier, the start, the
grace boundary, after the scheduled end, after closure, both orders of a
concurrent scan and closure, closure retries and concurrent closures, another
teacher, a cancelled lecture, a duplicate retry after closure, the frozen and
the open register schedules, closure after finalization, rollback on failure,
and a static guard for the additive migration, the schema and the unchanged
earlier migrations (SHA-256).

`npm run test:attendance-history` (also part of `npm run test:attendance`):
the history (`tests/attendance/attendance-history.test.cjs`) against a
read-only Prisma double that throws on any write: version order (with equal
and skewed timestamps), pagination at every page size without duplicates or
gaps, empty and missing registers / records, invalid cursors and limits,
wrong teacher / student, sanitized output, no writes, and immutability.

`npm run test:attendance-decisions` (also part of `npm run test:attendance`):
manual decisions (`tests/attendance/attendance-decisions.test.cjs`) against
the in-memory PostgreSQL model: first mark, changes and reason rules,
replacing automatic statuses, clearing reviews, no-op repeats, UNKNOWN /
NOT_APPROVED / removed students, unchanged eligibility, access errors,
versions, concurrent decisions, lock order, after finalization (including a
finalization ABSENT), audit rollback, lock timeout, and later QR / online
evidence.

`npm run test:attendance-schedule` (also part of `npm run test:attendance`):
schedule synchronization and the finalized-lecture guard
(`tests/attendance/schedule-sync.test.cjs`), running the real lecture service
against the in-memory PostgreSQL model: start / end / cleared-end / title-only
/ same-value edits, no register creation, recalculation by record source at
the grace boundary, kept reviews, stale registers, finalized registers
untouched, classification across the evidence start, the QR window, concurrent
scan / decision / closure, lock timeout, audit rollback of the lecture update,
re-checks under the lock, lock order, and cancel / delete protection.

`npm run test:attendance-reconcile` (also part of `npm run test:attendance`):
online reconciliation (`tests/attendance/reconcile.test.cjs`) against the
in-memory PostgreSQL model: earliest eligible visit across restarted sessions,
tie-breaks, per-visit eligibility, never-enrolled / NOT_APPROVED / UNKNOWN,
inactive and foreign students, idempotency, a dispatcher record moved to an
earlier visit, historical / cancelled / deleted / foreign refusals, a lecture
cancelled mid-run, finalized registers (existing records only), teacher /
BACKFILL / pending-review preservation, concurrency with the dispatcher, a QR
scan, a teacher decision and a schedule edit, busy students, cursor pages and
the 500 cap, missing configuration, and sanitized output.

`npm run test:attendance-backfill` (also part of `npm run test:attendance`):
historical backfill (`tests/attendance/backfill.test.cjs`) against the
in-memory PostgreSQL model, plus the CLI logic (the script itself is never
run): dry run without writes or transactions, BACKFILL record and audit
contents, PRESENT always with the join-time `autoStatus` at the grace
boundary, earliest eligible visit across sessions, approval and enrolment at
`joinedAt`, UNKNOWN / NOT_APPROVED / inactive / foreign students, existing
AUTO / TEACHER / BACKFILL records untouched, insert races (backfill vs
backfill, teacher decision), idempotency, LIVE / finalized / cancelled /
deleted refusals, a lecture cancelled mid-run, busy students, 500-student
batches, argument validation, the execution and database confirmations,
class / date scopes, missing configuration, sanitized output and the
CLI-only import guard.

`npm run test:attendance-finalization-preview` (also part of `npm run
test:attendance`): the finalization preview
(`tests/attendance/finalization-preview.test.cjs`, through the real
`getRegister` against the in-memory PostgreSQL model behind a
write-refusing recorder) and the pure fingerprint
(`tests/attendance/finalization-fingerprint.test.cjs`): new / open / finalized
registers, the roster partition and record counts, UNKNOWN manual review,
NOT_APPROVED / removed / deleted / inactive students, historical and live
lectures, every blocker (readiness reasons, active session, pending and
unknown evidence, the 500-student roster), reviews that do not block,
missing configuration, determinism and order independence, a change for each
decision-relevant input, no change for QR closure and display-only data,
zero writes / transactions / locks / registers, sanitized output, and a
static guard (reads only through `getRegister`).

`npm run test:attendance-finalization` (also part of `npm run
test:attendance`): the finalization transaction
(`tests/attendance/finalization-service.test.cjs`) against the in-memory
PostgreSQL model: ABSENT only for CREATE_ABSENT students, existing records /
decisions / reviews untouched, UNKNOWN / NOT_APPROVED / removed / inactive /
deleted students, audits and counts, a new register, historical lectures,
every refusal (evidence, unknown evidence, active session, readiness,
cancelled / deleted, configuration, input), 500 vs 501 candidates, stale
fingerprints (decisions, records, schedule, grace), QR closure not
invalidating, approval / deletion races against the Student locks, candidate
set changes, idempotent and concurrent confirmations, integrity failures,
rollback of every write, lock order and ordering, the finalization-only
helper rules, and static guards. Not a real-PostgreSQL validation.

`npm run test:attendance-api` (also part of `npm run test:attendance`): the
four API routes and the overview route
(`tests/attendance/api-attendance-overview-route.test.cjs`: 401s, ownership,
class 404 / 400, register states, classification and missing configuration,
filters, pagination, the field contract, a fixed query count, the lecture
list unchanged) in-process (`tests/attendance/api-*-route.test.cjs`, shared
environment `tests/attendance/helpers/attendance-route-env.cjs`: a faked
session and the in-memory PostgreSQL model; the real routes, services, error
handler, same-origin check and middleware): middleware 401s, session and
ownership rules, lecture ids, the register contract and its field allowlist,
configuration nulls, read-only GETs, reconciliation limits / cursors /
bodies / busy passes / repeats, the preview contract and 503s, finalization
success, idempotency, stale / malformed fingerprints, blockers, invalid
bodies, same-origin rejections before authentication, the integrity log line
and concurrent confirmations. No database.
Stage 5.6a (`tests/attendance/api-decision-review-routes.test.cjs`): every
decision status, first mark without a reason, replacing / confirming an
existing status, finalized registers, stale versions (also after evidence),
invalid bodies, inactive / deleted / foreign / unknown students, foreign,
cancelled and deleted lectures, ACCEPT / DISMISS with and without reasons,
nothing pending, same-origin before authentication, a `teacherId` in the
body, sanitized responses, the Student lock first, a held Student row (409
busy) and a deactivation waiting for the action. Stage 5.6b
(`tests/attendance/api-history-routes.test.cjs`): both history routes'
pages, cursors, limits, invalid queries, ownership (no history read on
refusal), inactive and deleted students readable, read only, sanitization
and the exact service arguments. `tests/attendance/attendance-decisions.test.cjs`
now expects the Student lock first (Stage 5.6a).

`npm run test:attendance-grace` (also part of `npm run test:attendance`): the
grace period (`tests/attendance/grace.test.cjs` against the in-memory
PostgreSQL model: the effective change and its audits, every status source
after recalculation, reviews kept, the reason rule, the no-ops, register
creation, historical lectures, every refusal, rollback, lock order, busy,
the class default isolated from existing registers, and races with online /
QR evidence, decisions, reconciliation, finalization and concurrent register
creation; `tests/attendance/class-grace-default.test.cjs`: class
validation, create default 10, update unchanged when omitted, owner only,
no attendance access, same-origin before authentication on POST and PUT).
`tests/attendance/api-grace-route.test.cjs` (in `npm run test:attendance-api`):
the route's contract, no-ops, error mappings, strict body, same-origin and 401.

`npm run test:attendance-gap-report` (also part of `npm run test:attendance`):
the read-only gap report (`tests/attendance/gap-report.test.cjs`) against the
in-memory PostgreSQL model behind a write-refusing recorder: teacher scoping,
deleted / cancelled / historical (by date or register start) / finalized
exclusion, the evidence-start boundary, pending vs represented, multiple
visits and restarts, eligibility rules, agreement with the register view's
online-evidence check, missing configuration, pagination and limits, invalid
arguments, zero writes / transactions / locks / registers, sanitized output,
a bounded page query with one lecture processed at a time, and a static guard
against write, lock, transaction, reconciliation and backfill helpers.

`npm run test:attendance-ui` (not part of `npm run test:attendance`; also in
`npm run test:ui`): the grace-period UI (`attendance-grace-ui.test.tsx`: the
class forms' default and payload, availability, the draft rules, the
request helper, the controller over a fake fetch (reason required then an
explicit resubmission, 409 refresh without retry, busy, no-op message,
double submission, dispose), the dialog states and the register action),
the Stage 5.6 UI (`attendance-record-actions.test.ts`:
the decision / review / history helpers, reason rules, the action
controller and the history loaders; `attendance-decision-dialog.test.tsx`,
`attendance-review-dialog.test.tsx`, `attendance-history-ui.test.tsx`: both
layouts, dialog states, the real request flow over a fake fetch, modal
behaviour on fake DOM nodes, wiring) and the Stage 5.5d UI (`tests/ui/attendance-*.test.ts(x)`,
`tests/ui/dashboard-attendance-nav.test.tsx`), with no server or database:
the shared request helper and labels (an injected fetch with real
`Response` objects), the reconciliation loop, the register, reconciliation
and finalization views and controllers, dialog focus and inert handling,
the overview (tab and Sri Lankan date boundaries, filters, pagination,
register states, both layouts, error states, stale-response protection)
and the sidebar's Attendance item (rendered in the real dashboard shell:
link, active on the overview and register pages, similar prefixes, other
items' exact matching, pending lock, admin sidebar). Views render with
react-dom/server; no browser test.
