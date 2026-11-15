# Unified file storage: Stages 2 and 2.1 (Notes and assignment submissions)

Lecture Notes and student assignment submissions are written to `FILE_STORAGE_ROOT`. This is the same root and the same `Teachers/` tree that Recorded Lectures uses. Existing files stay where they are and are still read from there. Stage 3 will copy them.

```text
FILE_STORAGE_ROOT/Teachers/{teacherId}/Lectures/{lectureId}/
  Notes/{noteId}/{32 hex}.{pdf|png|jpg|webp|docx|doc|pptx|ppt|xlsx|xls|txt|zip}
  Assignments/{assignmentId}/Submissions/{submissionId}/{32 hex}.pdf
```

## Modules

| Module | Role |
|---|---|
| `lib/file-storage/open-root.ts` | The generic opener. It checks `FILE_STORAGE_ROOT`, creates `Teachers/` and caches one `LocalFileStorage` handle. It has no Recorded Lectures dependency; Recorded Lectures keeps its own opener. |
| `lib/notes/storage-keys.ts`, `lib/assignments/submission-keys.ts` | Server-generated keys. Note extensions come from the validated MIME type; submissions are always `.pdf`. Each module has a strict parser and maps a key to its paired legacy-copy path. |
| `lib/stored-files/stored-file.ts` | The only place these features write or read files. See below. |

`stored-file.ts` provides:
- `storeUpload`, `discardStoredUpload` and `removeReplacedUpload` for writes.
- `openStoredFileForRead`, which uses `storageKey` first, then the legacy `fileUrl`. It streams and never follows a link.

## Database

Migration `20261115120000_add_unified_file_storage_keys` is additive. It adds:
- nullable `storageKey` (unique) and `sha256` columns on `Note` and `AssignmentSubmission`;
- CHECK constraints for the digest format, the exact key layout, and "a key always comes with a digest";
- the trigger `*_clear_stale_storage_key`: an UPDATE that changes `fileUrl` without changing `storageKey` clears `storageKey` and `sha256` (see "Rollback").

`fileUrl` is unchanged and still required.

**The migration has not been applied to any database.**

## Rollback window: dual-write (Stage 2.1)

The previous application version reads only `fileUrl`, below `<cwd>/storage`. While the rollback window is open, every new upload is therefore stored twice. Both copies are complete and verified before the database row is written:

| Copy | Location | Read by |
|---|---|---|
| New storage (`storageKey`) | `FILE_STORAGE_ROOT/Teachers/.../{random}.{ext}` | This version |
| Legacy copy (`fileUrl`) | `<cwd>/storage/lectures/{lectureId}/{random}.{ext}` or `.../assignments/{assignmentId}/{random}.pdf`, the old layout with the same random name | The previous version |

**Write order and failure handling:**
1. Write the new-storage file (exact size, SHA-256, flushed). If this fails, nothing is left behind.
2. Write the legacy copy:
   - folders are created and checked one level at a time and never through a link;
   - the file is created exclusively, streamed, and must have the same size and SHA-256;
   - it is flushed.

   If this fails, both copies are removed and the request answers 503 (or 400 when the content differs).
3. Commit the row. If the commit fails, both copies are removed.
4. For a resubmission, after the commit only, remove the previous upload's own files: its new-storage file, plus its legacy copy if `fileUrl` is exactly that copy. A file written by the old application is never deleted.

A failed cleanup is logged and leaves an unreferenced file, never a broken reference. The inventory reports such files.

**Concurrent resubmissions:** the reference switches by compare-and-set on (`fileUrl`, `storageKey`), with up to 3 attempts and then `409 SUBMISSION_CONFLICT`. A losing attempt removes both of its copies. Two first submissions racing each other are settled by the unique `(assignmentId, studentId)` index.

**Consistency across versions:** after a rollback, the previous version's resubmission (an upsert) changes `fileUrl` only. The trigger then clears `storageKey` and `sha256`, so after rolling forward again this version reads the previous version's file, never the replaced one. Without the trigger, the row would point at a stale stored file.

**Switch:** `UNIFIED_STORAGE_LEGACY_DUAL_WRITE`. Dual-write is on unless the value is `off`, `false` or `0`; an unset or mistyped value keeps it on (fail-safe).

### When dual-write may be turned off

Only when **all** of these are true:
1. The decision is recorded that no build older than Stage 2.1 will be deployed again (the rollback window is closed).
2. The migration has been applied, and the Stage 2.1 build has run in production for the agreed period without a rollback.
3. An inventory run shows 0 `LEGACY_COPY_MISSING` and 0 `LEGACY_COPY_HASH_MISMATCH` among rollback copies. This confirms the window really was rollback-safe up to that point.
4. `FILE_STORAGE_ROOT` is included in backups.

After it is turned off:
- New uploads exist only in the new storage (`fileUrl` = `storageKey`), so a pre-2.1 build cannot serve them. That is why condition 1 comes first.
- Existing legacy copies keep working, and each is removed when its upload is replaced.

Removing the remaining rollback copies is a separate, approved cleanup, done together with the legacy retention (90 days after the Stage 3 migration has been verified).

### Rolling back during the window

- Redeploy the previous build. **Do not revert the migration:** the columns are nullable, unknown to the old build and harmless, and the trigger must stay in place for rolling forward again.
- Everything uploaded since Stage 2.1 is served from the legacy copies.
- Uploads made by the previous build have `storageKey` null and are read from `fileUrl` by every version.
- After rolling forward again, the inventory lists the stored files that were orphaned by resubmissions made during the rollback as unreferenced new-storage files.

### Prerequisites (outside this code)

1. `<cwd>/storage` must survive deployments: it must be the same persistent folder (or link) before and after a deploy and a rollback. If a deploy replaces the application folder, legacy files and rollback copies are lost. That risk already exists today. Verify it on the server before deploying.
2. `FILE_STORAGE_ROOT` must be set on every environment that accepts uploads. Without it, uploads answer 503 while legacy reads keep working. It must also be backed up together with the database.
3. During the window, Notes and submissions use about twice their disk space.
4. Deployment order: apply the migration, then run `prisma generate`, build, and deploy with dual-write on (the default).

## Behaviour summary

- **Reads:** all routes keep their access queries, headers and messages, and stream the file. `503 STORAGE_UNAVAILABLE` means the root is not configured or not usable.
- **API responses** no longer include `fileUrl`. No client used it; every file link goes through the routes by id.

# Teacher storage quota (Stage 3)

Implemented in the working tree:
- **Stage 3.1:** the foundation (schema, usage calculation, lock helper).
- **Stage 3.2:** enforcement for Notes uploads and assignment submissions.
- **Stage 3.3:** enforcement for Recorded Lecture uploads.
- **Stage 3.4:** admin storage management (APIs and the Storage card in the admin teacher panel).
- **Stage 3.5:** the teacher's own read-only storage usage (API and a card on the dashboard Overview).

Still to come: permanent deletion.

## Effective limit

Resolved by `resolveEffectiveStorageLimit` ([lib/storage-quota/usage.ts](../lib/storage-quota/usage.ts)):

1. The teacher's **individual override** (a `TeacherStorageLimit` row), when one exists. The admin sets it, even when the plan is unlimited.
2. Otherwise, the **active subscription plan's `storageGB`** (Stage 3.2): status ACTIVE and not past its `endDate`; the latest such subscription by `updatedAt`. Cancelled, expired and suspended subscriptions never supply the default limit. The individual override applies regardless of subscription status.
3. Otherwise, **unlimited**: the plan's `storageGB` is NULL, or the teacher has no active subscription.

Rules for limit values:
- `0` is a real limit: nothing may be stored. It never means unlimited; "unlimited" is the absence of a limit.
- Overrides and plan values range from 0 to 10^15 bytes (1 PB). Anything else is rejected (`InvalidStorageLimitError`), never treated as unlimited.
- **Units are decimal: 1 GB = 1,000,000,000 bytes.** The product already shows sizes this way (`formatDecimalSize`: the 4,000,000,000-byte part limit is "4 GB"). `storageGB` is multiplied by 10^9, never by 2^30.

## What counts

Only files referenced by valid database rows in the unified hierarchy, with sizes verified when the file was written:

| Category | Committed | Reserved |
|---|---|---|
| Recorded Lectures | `RecordedLecture`: state READY, `storedFileName` set, `purgedAt` NULL (status 0, or 2 = deleted but not yet purged) | ACTIVE or COMPLETING `RecordingUploadSession` (see below) |
| Notes and supporting material | `Note.storageKey` set, including soft-deleted notes and notes of removed lectures or classes | `StorageReservation` NOTE rows, not expired |
| Assignment submissions | `AssignmentSubmission.storageKey` set (teacher = Assignment → Lecture → Class) | `StorageReservation` SUBMISSION rows, not expired |

**Excluded:**
- material bundles, class papers, payment slips, payment messages and breakout files (all still in the legacy storage);
- legacy rows (`storageKey` NULL) and the legacy rollback copies;
- temporary chunks and assemblies (`System/`);
- unreferenced files.

**Recording reservations** follow the existing `reservationRows` rules exactly; a test compares the two:

| Session | Reserves |
|---|---|
| ACTIVE, before its upload expiry | the declared `expectedBytes` |
| ACTIVE, past expiry, with a current lease | `receivedBytes + leaseBytes` |
| ACTIVE, past expiry, without a current lease | nothing |
| COMPLETING | `expectedBytes` |

A recording becomes READY in the same transaction in which its session becomes COMPLETED (`markReady`), so it is never counted both as reserved and as committed.

**Computation:** `getTeacherStorageUsage(teacherId)` ([services/teacher-storage-usage-service.ts](../services/teacher-storage-usage-service.ts)) reads database rows only, never the filesystem.
- Notes and submission sums are taken in SQL as BIGINT (a Prisma `_sum` over an `Int` column could overflow).
- "Now" is database time (`serverNow`).
- Without a caller transaction, everything is read in one REPEATABLE READ snapshot.
- Inside a caller's transaction (enforcement, under the quota lock), reservations are read before committed rows, so a concurrent commit can only make usage look higher, never lower.

The result contains:
- per-category committed and reserved bytes, and their totals;
- the total of committed plus reserved bytes;
- the effective limit and its source (`OVERRIDE`, `PLAN`, `UNLIMITED_PLAN` or `NO_ACTIVE_SUBSCRIPTION`);
- the remaining bytes (limit − committed − reserved, never below 0);
- the usage percentage (committed + reserved; null when unlimited or the limit is 0);
- `isOverQuota` and `overQuotaBytes` (committed storage above the limit, for example after the limit was reduced).

`fitsWithinStorageLimit(usage, bytes)` is the decision upload enforcement will use.

**Serialization:** byte counts are BigInt in the backend. They cross every API boundary as decimal strings (`serializeTeacherStorageUsage`): `JSON.stringify` cannot encode BigInt, and `Number` loses precision above 2^53.

## Database (migration `20261116120000_add_teacher_storage_accounting`, not applied)

- **`TeacherStorageLimit`:** primary key `teacherId`, `limitBytes BIGINT` (CHECK 0 to 10^15), `updatedAt`, and the responsible admin's id and email. A missing row means no override.
- **`TeacherStorageLimitChange`:** append-only audit of the override before and after (NULL = none), the plan allocation at the time, the admin, and the time. The foreign key is RESTRICT, so the history is never cascaded away.
- **`StorageReservation`:** reservations for Notes and submissions only, with CHECKs on:
  - size: 1 to 2^31−1 bytes, the `Int` range of the rows the files become;
  - expiry after creation;
  - the key matching its category's exact layout;
  - the key lying below `Teachers/{teacherId}/` of the reserving teacher.

  The storage key is unique.
- Timestamps are written by the application (`serverNow`), with no database defaults.

## Reservation architecture

### Notes and submissions (Stage 3.2, enforced)

The service is [services/storage-reservation-service.ts](../services/storage-reservation-service.ts).

1. **`reserveTeacherStorage`**, in one short transaction:
   - take the quota lock, then read database time;
   - delete the teacher's expired reservations;
   - compute committed plus reserved usage;
   - insert a `StorageReservation` for the exact file size and the generated key, **only if** committed + reserved + requested ≤ limit.

   Otherwise the request answers 413 `STORAGE_QUOTA_EXCEEDED`. Nothing has been written yet.
2. **Write the files:** `storeUpload` (new storage plus the rollback copy, unchanged).
3. **`commitTeacherStorageReservation`**, in one transaction:
   - take the quota lock, then re-read the reservation;
   - a reservation of another teacher, category, key or size is refused;
   - a **missing or expired** reservation is not trusted: the quota is checked again as if reserving now;
   - then the row write (Note create, or the submission create or compare-and-set) and the reservation's deletion commit together.
4. **`releaseTeacherStorageReservation`** after any failure. It is best effort and logged. A reservation that cannot be released stops counting when it expires, and the next reservation removes it.

**Reservation lifetime:** 15 minutes (`STORAGE_RESERVATION_TTL_MS`). The file (at most 25 MB) has already been received in full before the reservation is made, and writing it, twice while dual-write is on, takes seconds. A request that outlives the lifetime is re-checked at commit.

**Notes upload:** authentication, the existing validation and the ownership check come first, unchanged. The order is then: generate the key, reserve, write, commit (inside `addNoteToLectureForTeacher`, so the ownership re-check stays). A failure removes the written files and releases the reservation.

**Submissions:**
- The teacher is resolved through Assignment → Lecture → Class.
- Each attempt reserves the **full** new size; a file it replaces still counts until the replacement commits.
- The compare-and-set update (or the first submission's create) runs inside the commit transaction.
- A lost compare-and-set deletes its own reservation in that transaction and discards only its own new files; the current submission's files are never touched.
- A failed commit (including a lost first-submission race) discards this attempt's files and releases its reservation before retrying.
- After a successful commit, only the new reference counts.

**413 responses:**
- Teachers get `details` with `limitBytes`, `usedBytes`, `reservedBytes`, `requestedBytes` and `remainingBytes` as decimal strings.
- Students get a generic message ("…your teacher's storage space is full…") without any figures.

These are distinct from 507 (the server disk is full). A quota lock that is not obtained within 10 s answers 503 `STORAGE_QUOTA_BUSY` (retry).

### Recorded Lectures (Stage 3.3, enforced)

`startRecordingUpload` (`POST /api/lectures/[id]/recorded-lectures/uploads`) checks the quota inside its existing start transaction. The order is:

1. lock timeout, then the **teacher upload lock** (level 1);
2. the teacher account and the lecture are re-checked;
3. stale uploads are expired;
4. the **3-active-uploads cap**;
5. **the teacher storage quota lock** (level 2), then usage (committed plus reserved, including this teacher's other ACTIVE or COMPLETING sessions and the Notes and submission reservations). The new recording's declared size is added **once**, as the request; it is not stored yet.

   It must fit, or the response is 413 `STORAGE_QUOTA_EXCEEDED` with the teacher's figures. A quota lock timeout is 503 `STORAGE_QUOTA_BUSY`.
6. the **global capacity lock** (level 3);
7. the recording and session rows;
8. the existing **disk** decision: 507 `INSUFFICIENT_STORAGE` is unchanged and still separate from the quota.

**The upload session is the reservation;** no `StorageReservation` row is ever created for a recording. Lifecycle:
- **ACTIVE:** reserves its declared size.
- **ACTIVE, past its upload expiry:**
  - with a current chunk lease, it reserves only the bytes received plus the lease;
  - without one, it reserves nothing. The next start expires it.
- **COMPLETING (assembly and verification):** still reserves the declared size.
- **CANCELLED, EXPIRED or FAILED:** nothing; the space is free again immediately.
- **READY:** the session becomes COMPLETED and the recording READY in **one** transaction (`markReady`). The size moves from reserved to committed and is never counted twice.

The declared size is a hard upper bound: a database CHECK keeps `receivedBytes ≤ expectedBytes`, chunk leases fit what remains, and assembly writes exactly `expectedBytes`. Chunk uploads and completion therefore need no quota check of their own, and they were not changed. A limit reduced after an upload started does not stop that upload, because it was already reserved.

The upload page shows fixed messages for `STORAGE_QUOTA_EXCEEDED` and `STORAGE_QUOTA_BUSY` (`components/recorded-lectures/upload-engine.ts`); there are no other client changes.

## Admin storage management (Stage 3.4)

The service is [services/admin-teacher-storage-service.ts](../services/admin-teacher-storage-service.ts). The shared parsing and formatting is [lib/storage-quota/limit-input.ts](../lib/storage-quota/limit-input.ts).

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/teachers/[teacherId]/storage` | Committed and reserved bytes per category, totals, effective limit and its source, remaining bytes, percentage, unlimited / over-limit state, the individual override, and the subscription (the active one that supplies the plan limit, plus the latest of any status for context) |
| `PUT /api/admin/teachers/[teacherId]/storage-limit` | Set or remove the individual override; responds with the updated summary and `changed` |
| `GET /api/admin/teachers/[teacherId]/storage-limit/history?page=&pageSize=` | The audit history, newest first, paginated |

Usage always comes from `getTeacherStorageUsage`. Byte counts are decimal strings, and no storage key, path, hash or file detail is ever returned.

**Access:** administrators only (`requireAdminSession`). Without a session the response is 401; a teacher or student session gets 403. A malformed teacher id is 400, an unknown one 404. The teacher comes from the URL and the administrator from the session, never from the body.

**PUT body**, exactly one of the following (decimal GB, 1 GB = 1,000,000,000 bytes):

```json
{ "limitGB": "12.5" }
{ "limitBytes": "12500000000" }
{ "removeOverride": true }
```

**Validation:**
- `limitGB` is a whole number or has up to 9 decimals (one byte), parsed exactly with BigInt; `limitBytes` is a decimal string.
- Both range from 0 to 1,000,000 GB (10^15 bytes, 1 PB).
- Negative, non-numeric, finer-than-a-byte, excessive or ambiguous values are 400. Any other field (`teacherId`, `adminId`, …) is refused by name.
- `0` is a real limit (nothing more may be stored), never unlimited.

**Writes:** the override (upsert or delete) and its `TeacherStorageLimitChange` row are written in **one transaction** holding the teacher's quota lock (level 2 only), so admin changes are serialised with uploads and with each other.
- The audit row records the previous and new override (NULL = none), the **active** plan's limit at that moment, the session's admin id and email, and database time.
- A request that changes nothing (the same limit, or removing a missing override) writes nothing and returns `changed: false`.
- A limit below the current usage is saved. Files are never touched. The response shows the over-limit state (`usage.isOverQuota` for stored files, `isOverLimitIncludingReservations` for stored plus reserved), and the existing enforcement refuses new uploads.

**Admin UI:** a Storage card in the admin teacher detail panel ([components/admin-teacher-storage-card.tsx](../components/admin-teacher-storage-card.tsx)). It shows:
- the overview (stored, reserved, total, limit, remaining, percentage, a Within / Over limit / Unlimited badge, and the limit's source);
- the three categories, each stored and reserved;
- the plan allocation and the individual limit;
- a GB input with "Save limit" and "Remove individual limit";
- the last 5 changes.

Before a limit below the current usage (stored plus reserved) is saved, or before removing an override would drop the teacher to a lower plan limit, the card asks for confirmation. It explains that files are not deleted, that the teacher may immediately be over the limit, and that new uploads are refused until usage falls below it.

## Teacher storage dashboard (Stage 3.5)

**API:** `GET /api/teacher/storage` ([app/api/teacher/storage/route.ts](../app/api/teacher/storage/route.ts)).
- Teachers only (`requireTeacherSession`); any other session or none gets 401.
- The teacher is taken **only from the session**: no query parameter, header or body can name another teacher.
- It calls `getTeacherStorageUsage(session.teacherId)`, which reads database rows only, never the filesystem.
- The response is the teacher-safe view [lib/storage-quota/teacher-view.ts](../lib/storage-quota/teacher-view.ts):
  - per category (Recorded Lectures, Notes & Materials, Student Submissions): stored, uploading (reserved) and total;
  - overall stored, reserved and total;
  - the effective limit and a plain source (`INDIVIDUAL`, `PLAN`, `UNLIMITED_PLAN` or `NO_ACTIVE_SUBSCRIPTION`);
  - remaining bytes, percentage, unlimited, over quota (stored files above the limit, and by how much), and over the limit including uploads in progress.
- Byte counts are decimal strings, with the totals added server-side in BigInt.
- **Not returned:** the override's value, the plan figure, any administrator identity, the limit history, ids, storage keys, paths or hashes.
- It is GET only, with no editing endpoint.

**UI:** a "Storage usage" card on the teacher dashboard Overview, after the metric cards ([components/dashboard/dashboard-storage-usage.tsx](../components/dashboard/dashboard-storage-usage.tsx)). It shows:
- a status badge: Within quota, Limit reached, Over quota or Unlimited storage;
- where the limit comes from;
- a progress bar ("X of Y used (Z%)"), and Used / Allocated / Remaining / Used (%). "Used" separates stored files from uploads in progress;
- a category table (Stored / Uploading / Total).

**Special states:**
- **Unlimited:** usage and categories are still shown, without a remaining value, percentage or bar.
- **Over quota:** states by how much, that new uploads may be refused until storage is freed or an administrator raises the limit, and that existing files stay available (nothing is deleted).
- **Other states:** loading, error with "Try again", and zero usage.

The card is **read only**: no input, form or limit control, only Refresh. It also refreshes with the dashboard's other cards on live events.

## Advisory-lock order

`lockTeacherStorageQuota(tx, teacherId)` ([lib/storage-quota/locks.ts](../lib/storage-quota/locks.ts)) takes a PostgreSQL **transaction** advisory lock. It serialises across all processes and is released on commit or rollback.

Always acquire in this order, skipping levels that are not needed:
1. `lockTeacherUploads` (Recorded Lectures, per teacher)
2. `lockTeacherStorageQuota` (per teacher)
3. `lockUploadCapacity` (Recorded Lectures, global)

`tests/storage-quota/locks.test.cjs` checks every caller in `app`, `services` and `lib` for this order.

## Permanent deletion (Stage 3.6)

When a teacher deletes a **Note**, an **assignment** or a **Recorded Lecture**, its stored files are deleted **permanently and physically**. There is no recycle bin and no restore.

- Deleting an **assignment** deletes **every student submission and its PDF**.
- Individual submissions have no teacher delete action (none existed before). They are deleted only through their assignment.
- Every deletion asks for an explicit, **irreversible** confirmation in the UI.

### Lifecycle (recoverable, idempotent)

1. **Mark.** One short statement, committed before any file is touched. Notes and assignments go `status 0 → 2` ("permanent deletion pending"). Recordings use their existing `status 2` + `purgeRequestedAt`. Every page, API and count already filters `status: 0`, so the item disappears everywhere at once, and **no schema change was needed**.
2. **Files.** Deleted one by one, outside any database transaction, through the strict single-file helpers (`removeStoredFileStrict`, `removeLegacyCopyStrict`, and Recorded Lectures storage `remove`).
   - A file that is already missing counts as deleted.
   - Any other failure leaves the item pending.
3. **Finalize.** Only after every file is gone:
   - a Note's row is deleted (its `NoteStudent` rows cascade);
   - each submission row is deleted after its own files, and the assignment row after its last submission;
   - a recording becomes `status 1`, with `purgedAt` set and `purgeRequestedAt` cleared.

**Usage.** A file keeps counting toward the teacher's quota until its row is finalized. Notes and submissions count by `storageKey`, whatever their status. Recordings count while `purgedAt IS NULL`. So the quota never under-counts a file that still exists.

**Retries.** Any step can fail or crash. It is finished by:
- the teacher's repeated DELETE (a pending item is still addressable by its owner), or
- the maintenance scheduler.

### What may be deleted

- **New-storage file.** Only if its key parses as a key of exactly this resource:
  - the teacher comes from the database;
  - the lecture, note, assignment and submission ids must all match.
  
  A key that does not verify is never deleted. The item stays pending and the problem is logged.
- **Rollback copy (dual-write).** Only when the row's `fileUrl` is exactly the copy paired with the key (`legacyCopyPathFor`).
- **Recording file.** Only at the key built from the row's own teacher, lecture, id and validated `storedFileName`.
- **Protected recordings.** A recording is never purged while it is VERIFYING or while an upload session of it is ACTIVE or COMPLETING.
- **Never deleted:** directories (except an already-empty recording folder) or anything through a link.
- **Legacy-only rows** (`storageKey` NULL: uploaded before unified storage):
  - the row is deleted, but the legacy file is **retained**, because it cannot be verified as the row's own;
  - such files were never counted in usage;
  - the inventory tool reports them as unreferenced.
  
  Cleaning them up is a later, separate decision (no legacy migration in this stage).
- **Notes and assignments removed by earlier versions** (`status 1`) are left as they are. They keep counting if they have a `storageKey`. This is a later decision too.

### Assignment cascade and new submissions

While an assignment is pending, the submit route refuses new submissions:
- its lookup requires `status: 0`;
- it **re-checks** `status: 0` inside its quota-locked commit transaction.

The finalize step counts the remaining submissions and deletes the assignment in **one transaction under the teacher's storage quota lock**, so it serialises with every submission commit. A submission committed just before the mark is therefore seen and deleted (files first) by the next pass. It is never cascade-deleted with its PDF left behind.

The lock order is unchanged: the quota lock is taken alone. `tests/storage-quota/locks.test.cjs` declares this caller.

### API

| DELETE | 200 | 202 |
|---|---|---|
| `/api/lectures/{id}/notes/{noteId}` | `{ deleted: true, pending: false }`: the note and its file are gone | `{ deleted: false, pending: true }`: hidden, file deletion pending |
| `/api/lectures/{id}/assignments/{assignmentId}` | the assignment, all submissions and all PDFs are gone | hidden, accepts no submissions, the rest pending |
| `/api/recorded-lectures/{recordingId}` | file gone, `status 1` | hidden, file deletion pending |

The UI shows success **only** for 200. A 202 is shown as a separate "still being deleted, finishes automatically" notice. Repeated clicks are ignored while a request runs.

### Maintenance scheduler (now wired)

`instrumentation.ts` starts `startRecordedLectureMaintenance()` once per server process, in the existing guarded branch:
- Node.js runtime and `NODE_ENV=production`;
- not during `next build`;
- the scheduler also checks itself (`canRunMaintenanceScheduler`: not serverless, and `FILE_STORAGE_ROOT` set).

It never starts in development or in tests. There is no HTTP endpoint for it, and production runs one PM2 process, so there is one instance.

Each tick runs under the existing in-process overlap guard (a tick during a run is skipped) and does the following:
- expiry and recovery;
- the temporary-file and orphan sweeps on their cadence;
- **purge** of deleted recordings (`purgeRemovedRecordings`, up to 50 per run);
- **`retryPendingDeletions`** for Notes (up to 100) and assignments (up to 20, with up to 200 submissions each), with a 20-second budget.

Failures are logged and retried.

**Stage 3.7 changes:**
- **Fairness.** Each pass of the purge and of the Note/assignment retry continues after the last id of the previous pass, wrapping at the end. Items that keep failing can never occupy every slot.
- **Backoff.** A failed item is skipped for 1, 2, 4 … 60 minutes, so it is logged once per attempt rather than every minute.
  - This state is in process memory only; a restart retries everything once, which is safe.
  - The teacher's own repeated DELETE ignores the backoff.
- **Orphan sweep.** A purged recording (`status 1`) now counts as removed: leftover files in its folder are orphans (deleted after the 48-hour grace) and the folder is removed. The "READY file missing" data-loss alarm is raised only for active (`status 0`) recordings. A recording pending purge keeps its file until the purge deletes it.
- **Logging.** A failed rollback-copy removal is logged as a fixed-message error with its errno code, never as the raw Node error (which contains the absolute path).

### Not verified here

The fake-database tests cover the application logic. They do **not** prove PostgreSQL behaviour: the advisory-lock serialisation and the READ COMMITTED visibility at finalize. Those need the approved local test database, which does not exist yet.

The migrations `20261115120000` and `20261116120000` are still **not applied** anywhere. Stage 3.6 adds no migration.

# Teacher profile photos

Teachers' profile photos are stored on unified storage and count toward the storage quota as their own category, **Profile Images** (`PROFILE_IMAGE`).

## Where they live

```
FILE_STORAGE_ROOT/Teachers/{teacherId}/Profile/Photo/{32 hex}.{jpg|png|webp}
```

- [lib/profile-images/storage-keys.ts](../lib/profile-images/storage-keys.ts) generates and parses the keys. The teacher id comes from the session, the name is random and the extension follows the detected type. Every upload gets a new key.
- Database columns on `TeacherProfile`:
  - `profileImageStorageKey`, `profileImageSha256`, `profileImageSizeBytes` and `profileImageMimeType` are set and cleared together.
  - `profileImageUrl` stays the display URL that every consumer reads: the profile header, the public profile, search, and the Jitsi `photoUrl`.
  - A unified photo's URL is `/api/teacher-photos/{teacherId}/{storedName}`. It is unique per upload, so it is cached as immutable.
- Migrations, created but **not applied**:
  - `20261117120000_add_profile_image_reservation_category` adds the enum value on its own.
  - `20261117120100_add_teacher_profile_image_storage` adds the columns, the unique key and the CHECKs (all-or-none, key format, owner, digest, size of 1 byte to 2 MB, type, extension matches type). It also extends the reservation key CHECK.

## Upload and replace (`PUT /api/teacher/profile/photo`)

1. The same-origin check and the session check run **before** any of the body is read.
2. The body is read with a hard 2 MB limit, enforced while reading: Content-Length first, then every chunk.
3. The type is detected from the file's own bytes. Only JPEG, PNG and WebP are accepted, with structural checks. SVG, HTML, GIF and malformed files get 415.
4. The full new size is reserved under the teacher's quota lock. The old photo keeps counting, so a replacement never frees quota in advance.
5. The photo is streamed to a new key, with SHA-256 computed and the exact size checked.
6. In one transaction under the quota lock, the profile row is updated with a compare-and-set and the reservation is deleted. A lost race discards this attempt's file and retries, up to 3 attempts.
7. After the commit, the previous unified photo is deleted. If that fails, it is logged and left for the orphan sweep (it is no longer counted).

On any failure the old photo stays; partial files and reservations are removed. Legacy photos are never deleted.

## Remove (`DELETE /api/teacher/profile/photo`)

1. `profileImageUrl` is cleared, so the photo is hidden everywhere at once. The key stays, so the photo still counts.
2. The file is deleted. A file that is already missing counts as deleted.
3. The four columns are cleared, and only now is the quota released.

The response is 200 when the removal is complete, or 202 when it is pending. The maintenance tick finishes pending removals, backing off a failed one for 1 to 60 minutes. For a legacy photo, only the URL is cleared and the file is kept. There is **no administrator removal**.

## Serving

- **`/api/teacher-photos/...`** serves only the teacher's **current** photo. A replaced, removed, pending or unknown name returns 404. Headers: the stored type, `nosniff`, a sandboxing CSP, and `Content-Disposition: inline`.
- **`/uploads/teachers/{name}`** (legacy) keeps existing URLs working and is hardened:
  - only the old naming pattern with a raster extension is accepted, and SVG is never served;
  - the file is opened by the confined legacy reader, which stays inside the folder and never follows a link;
  - the same safety headers are sent.
- With no photo, `GET /api/teacher/profile/photo` returns `profileImageUrl: null` and the UI shows its placeholder. The old `/images/avatar.png` default never existed.

## Maintenance

The existing maintenance tick handles profile photos under the same overlap guard; there is no new scheduler.
- **Pending removals:** every tick.
- **Orphan sweep:** at most every 6 hours (`sweepProfilePhotoOrphans`). It lists only `Teachers/*/Profile/Photo/`. A file is deleted only when all of these hold:
  - the name parses as a photo key of that teacher;
  - the teacher's row does not reference it (the database is read first);
  - no unexpired `PROFILE_IMAGE` reservation names it;
  - it is older than 24 hours.

  Links and unknown files are never touched.
- **Inventory:** the scan lists `Teachers/*/Profile` as another feature's folder, so it is never reported as unexpected or unreferenced. The orphan sweep checks its references instead.

## Not verified here

All tests use an in-memory database fake. The quota lock is emulated as a mutex. Neither migration has been applied to any database, and no PostgreSQL behaviour has been validated.
