# Recorded lecture uploads: storage concurrency and verification

Requirements for the teacher recording upload APIs (Recorded Lectures RL-3).
They constrain how RL-3.2 and later stages may write and verify files below
`FILE_STORAGE_ROOT`, and how the application may be deployed.

## Chunk storage (RL-3.3, Option B)

Every accepted chunk is its own file, written once and never modified:

    System/TemporaryUploads/{uploadId}.{leaseToken}.chunk

- Each chunk request gets a fresh 256-bit lease token (transaction A). The
  body streams into that token's file only: created exclusively, the exact
  declared byte count, SHA-256 computed while streaming, never held in memory.
- The file is flushed (fsync), closed and its directory flushed (POSIX)
  **before** the database commit (transaction B) records it as a
  `RecordingUploadChunk` (same `leaseToken`, `startOffset`, `byteLength`,
  `sha256`) and advances the session's `receivedBytes` / `chunkCount`.
- There is **no shared `.part` file during an upload**. Chunks are joined
  once, at completion (RL-3.4).
- Transaction B commits only while **all** hold, in one conditional update:
  the session is `ACTIVE`; the upload has not expired; the lease token is
  still this request's; the lease has **not** expired; the received offset,
  chunk count and version are unchanged; and (checked in the same
  transaction) the teacher account and the lecture / class are still active.
  A chunk is never committed after its lease expired, even if no one else
  took the lease.
- After a **definite** failure (the transaction certainly rolled back), the
  request removes only its own, uncommitted token file. After an
  **ambiguous** failure (the commit's outcome is unknown, e.g. a broken
  connection), the database is read again: if the chunk row exists the chunk
  was accepted; otherwise the file is **kept** until cleanup can establish
  from the database that no committed chunk names it.
- A committed chunk's file is never modified or deleted by an upload request.

Why this fences stale writers: a request whose lease expired (a stall, a
second process) can only ever write its **own** token file. Nothing
references that file unless its own commit succeeds, and that commit is
refused once its lease expired or was replaced. Committed data cannot be
overwritten by any writer, in this process or another.

### Directory flush (durability)

`writeNewFile({ sync: true, syncDirectory: true })` flushes the file, closes
it, then flushes its directory, so the new file's name survives a crash or
power loss before the database records it.

- **Linux / POSIX (production):** the directory is opened read-only and
  fsync'ed. A failure fails the chunk (the file is removed, nothing is
  committed).
- **Windows (development only):** Node.js can open a directory but `fsync` on
  it fails with `EPERM`, so the directory flush is skipped and reported as
  `directorySynced: false`. The file itself is still flushed.

## Filesystem concurrency (single writer)

- **Exactly one application process may write to `FILE_STORAGE_ROOT`** in the
  initial deployment: today's production is one PM2 app (`slclassroom`, fork
  mode, one `next-server` process). Do not run the app with PM2 `instances > 1`
  or cluster mode, on a second server, or in a second container that mounts
  the same storage, until cross-process protection for completion and cleanup
  has been designed and approved. (Chunk uploads themselves are fenced by
  Option B; completion and cleanup still rely on this rule.)
- **Development and production must never share a storage root.** A local
  `next dev` must use its own `FILE_STORAGE_ROOT`, never a mount or copy path
  of the production root.
- **Cleanup workers must not delete files of an upload with an active lease**
  (a current `leaseToken` / `leaseExpiresAt` on its `RecordingUploadSession`),
  and must **never delete a committed chunk file** (its token appears in
  `RecordingUploadChunk`) while its upload is not final (`ACTIVE` or
  `COMPLETING`). An uncommitted token file may be deleted only when the
  database shows no committed chunk names it, it is not the current lease's
  file, and it is older than the scratch grace period. These rules are
  implemented in `lib/recorded-lectures/cleanup-rules.ts` (RL-3.5; the old
  `scratchFileDisposition` helper is retired).
- **The in-process mutex is not cross-process protection.**
  `UploadMutex` (`lib/recorded-lectures/upload-locks.ts`) is a JavaScript object
  inside one Node.js process. It serializes that process's own requests for an
  upload (lease, stream, commit, completion, cancellation cleanup). Another
  process does not see it. Lock order everywhere: the mutex first, then
  database locks.
- **Database leases do not fence stale filesystem writes.** A lease decides
  who may *start* writing; it cannot stop a write already in progress, and the
  database is not consulted during a write. An open file handle also keeps
  writing to the same file after it has been renamed (promoted). Option B
  makes this harmless for chunks (each writer has its own file); for any file
  that more than one request could write (completion), the claim-specific
  paths below are required.

## Completion and cancellation (RL-3.4)

### Completion is asynchronous

`POST /api/recorded-lectures/uploads/[uploadId]/complete` claims the upload and
answers **202** (`uploadState: COMPLETING`, `recordingState: VERIFYING`). A
background job in the same process then verifies, assembles, inspects,
publishes and marks the recording `READY`.

**Clients poll** `GET /api/recorded-lectures/uploads/[uploadId]`:

- `COMPLETING` (`completionStalled: false`): still working; poll again.
- `COMPLETING` with `completionStalled: true`: the completion stopped (a
  temporary failure such as disk full, or a server restart). Call `complete`
  again: it takes the stale claim over and starts again.
- `COMPLETED` / `READY`: done.
- `FAILED` with `failureCode`: the upload is bad (for example
  `CHUNK_HASH_MISMATCH`, `MP4_NOT_MP4`, `DURATION_INVALID`); upload again.

Calling `complete` again while a completion is running only returns the
status. RL-3.5 adds automatic recovery of stale claims by the maintenance
worker (below); **it is built but not yet started by the application**, so
until it is enabled, recovery still needs another `complete` request.

### Completion claim (no schema change)

- **Identity:** the session's `version` after the claim, plus a fresh random
  file name stored in the recording's `storedFileName`, plus the session's
  `lastActivityAt` as heartbeat (refreshed every 30 seconds while the job
  runs, conditional on the claim; a failed refresh stops the job at once).
- **Stale:** no heartbeat for 10 minutes. Only then may another `complete`
  take the claim over (new version, new file name), or `DELETE` cancel it.
- **Claim-specific files:** the assembly
  `System/TemporaryUploads/{uploadId}.{claimHex}.assembly` and the final
  `.../RecordedLectures/{recordingId}/{claimName}`, both created without ever
  overwriting.
- **Fencing:** every READY, FAILED, heartbeat and "make stale" transition is
  conditional on the claim (session `version`, recording `storedFileName`). A
  stale job can therefore never mark a newer claim READY or FAILED, never
  overwrite a newer claim's files, and only ever removes its own claim-named
  files.

### Capacity

A `COMPLETING` session reserves its full size (`expectedBytes`) for assembly,
on top of the existing `ACTIVE` reservations (the bytes still expected plus
twice each current lease), under the same 128 MiB in-flight cap and 5 GiB
minimum free space. The claim itself is refused (507, nothing changes) when
the assembly reservation does not fit.

### Job steps

1. Chunk records: exact count, indexes, contiguous offsets, total size, a hash
   each.
2. Every chunk file exists with exactly its recorded size.
3. Assembly into the claim's file, each chunk's SHA-256 recomputed while
   copying (bounded memory); file and directory flushed.
4. D5 second pass over the assembled file (below).
5. MP4 inspection (H.264 + AAC, duration 1 to 172,800 seconds).
6. A fresh heartbeat, then publish (`promote`, never overwrites) and flush
   both directories.
7. READY, conditional on the claim.
8. Committed chunk files deleted, best effort (a failure never affects READY).

Failures: permanent (the upload is bad, or the teacher / lecture is no longer
allowed) make the upload `FAILED`; temporary (disk full, I/O, database) keep
the claim and make it stale at once, for a retry; an unknown READY outcome
keeps every file.

### Cancellation

`DELETE /api/recorded-lectures/uploads/[uploadId]` changes the database only;
it never deletes a file (RL-3.5 cleans up).

- `ACTIVE`: takes the same per-upload mutex as chunk requests; if a chunk is
  being received by this process, **409 `UPLOAD_BUSY` and nothing changes**.
  Then the **database lease** decides, because a chunk writer may run in
  another process that the mutex cannot see: while a chunk lease is current,
  **409 `CHUNK_IN_PROGRESS` with `Retry-After`** (seconds until the lease
  expires) and nothing changes: the session, the recording, the lease and its
  capacity reservation all stay. Otherwise `CANCELLED`, recording `FAILED`
  (`UPLOAD_CANCELLED`), in one update conditional on the session's version and
  on no current lease (a lease granted meanwhile makes it fail: 409
  `CHUNK_IN_PROGRESS`). An expired upload is reported `EXPIRED`.
- Why an *expired* lease may be released: the writer's own write deadline is
  `leaseExpiresAt - 60 s` (for the default 300 s lease). It checks that
  deadline before every piece, and a pending read is rejected at it, so after
  the deadline it accepts no further piece; at most one piece it had already
  received may still be finishing its single write, then its file is deleted.
  At lease expiry the writer is therefore at least 60 seconds past its
  deadline, and releasing its reservation can leave at most that one piece
  unreserved for a moment (covered by the 5 GiB minimum free space).
- `COMPLETING`: only when the claim is stale (conditional on its version and
  file name; no mutex needed, the old job's later transitions are fenced);
  otherwise 409 `UPLOAD_COMPLETING`.
- `COMPLETED`: 409 `UPLOAD_ALREADY_COMPLETED`. Already ended: 200, unchanged.

## Maintenance: cleanup, expiry and recovery (RL-3.5)

`services/recorded-lecture-maintenance-service.ts` runs four bounded phases:

1. **Expiry:** `ACTIVE` uploads past their 24-hour expiry become `EXPIRED`,
   **but only once they have no current chunk lease**. A writer granted a
   lease shortly before the upload expired may still write until its lease
   ends; its capacity reservation stays until then.
2. **Recovery:** `COMPLETING` uploads whose heartbeat is older than 10 minutes
   are taken over by a new claim (`recoverStaleCompletion`, the same
   conditional takeover as a `complete` request, without a teacher request).
   Of two workers only one wins. A claim whose teacher account or lecture is
   no longer allowed is marked `FAILED` instead (`TEACHER_ACCOUNT_INACTIVE` /
   `LECTURE_NOT_ACTIVE`), under the same conditions. After a recovery, the
   same upload waits 1, 2, 4 ... up to 60 minutes before the next one (kept
   in memory; reset by a restart).
3. **Temporary files** (`System/TemporaryUploads`): chunk, assembly and legacy
   `.part` files, by the rules in `cleanup-rules.ts`:

   | File | Deleted when (all must hold) |
   |---|---|
   | Chunk, uncommitted | not the current, unexpired lease; no committed chunk row has its token; 15 min since last modified |
   | Chunk, committed | the upload is final (`COMPLETED`, `CANCELLED`, `FAILED`, `EXPIRED`) and ended at least 15 min ago (or the upload no longer exists) |
   | Assembly | not the current claim's (session not `COMPLETING`, or the recording's `storedFileName` is another claim's); 15 min |
   | `.part` | the upload is final or gone; 15 min |

4. **Final files** (`Teachers/.../RecordedLectures/{recordingId}/`): a file is
   kept while its recording exists with that `storedFileName` and is not
   `FAILED` (`READY`, or a claim between publishing and `READY`). Any other
   `.mp4` there is deleted only **48 hours** after its last modification. Empty
   folders of removed or `FAILED` recordings are removed. A `READY` recording
   whose file is missing is reported, never "fixed". Recordings removed by a
   teacher are not purged in this stage.

**Deletion safety.** A file is deleted only if:

- its name parses as one of the recorded-lecture file kinds (unknown names,
  symlinks and other entries are never touched; directories are listed
  without following links);
- the database was read for it (the session and its lease **first**, then the
  committed chunk rows, so a commit landing in between can never be missed);
- the rule says delete, which always needs the grace period **and** a one-way
  condition (lease tokens are never reused; final states, a replaced claim
  name and a removed or `FAILED` recording never change back), so a
  concurrent change cannot make the deletion unsafe.

A database error aborts the phase before anything of that batch is deleted.
Only the two feature folders are ever listed.

**Limits per run:** 20 s of wall-clock time; 100 expirations; 1 new recovery
(and only while fewer than 2 completion jobs run here); temporary sweep up to
50,000 entries, database batches of 200 uploads, 200 deletions; final sweep
up to 500 recording folders (resuming from the last one; the position is kept
in memory) and 200 deletions. One filesystem operation at a time.

### Disk space a writer can still use after its reservation ends

Reservations cover a writer only while its lease (or claim) is current. After
that it can no longer start a new piece (its deadline is checked before every
piece), but one piece it already received may still be completing. To bound
that:

- every write is at most **64 KiB** (larger network pieces are split);
- a process runs at most **32 chunk writers** (counted from before the lease
  grant until the write has fully settled, also past its deadline) and at most
  **4 completion jobs**.

At most (32 + 4) x 64 KiB = **2.25 MiB per process** can therefore be written
outside any reservation (about 4.5 MiB during an overlapping restart), far
below the 5 GiB minimum free space. More processes multiply it.

### Scheduler (built, NOT enabled)

`services/recorded-lecture-maintenance-scheduler.ts`: a first run 30 s after
start (startup recovery), then every 60 s; the temporary sweep at most every
5 minutes and the final-file sweep at most every 6 hours; runs never overlap;
only on a long-running production Node server with the storage configured.
On `SIGTERM` / `SIGINT` it stops and abandons this process's running
completion claims (fenced), so the next process recovers them at once; the
signal then takes its normal course.

**It is not wired into `instrumentation.ts`.** Until that separate, reviewed
step, nothing runs automatically.

## Verification before READY (D5)

Before a recording may become `READY`, the stored file is verified against
the committed chunk records (`RecordingUploadChunk`):

1. **Every committed chunk is verified against its stored hash.** The chunk
   rows are read in `chunkIndex` order. A chunk without a `sha256` (NULL) fails
   verification. So does any mismatch: fail closed, upload `FAILED`
   (`UPLOAD_VERIFICATION_FAILED`).
2. **Each hash covers exactly the recorded range:** the bytes from
   `startOffset` to `startOffset + byteLength - 1` of the file, using the
   recorded values, never values recomputed from the configured chunk size.
3. **The ranges must cover the whole file with no gap or overlap:** the
   first `startOffset` is 0, each next `startOffset` equals the previous
   `startOffset + byteLength`, and the sum of all `byteLength` equals
   `expectedBytes`. The number of rows equals the session's `chunkCount`.
4. **The complete expected file size is checked:** the file's size equals
   `expectedBytes` exactly (no missing and no extra bytes).
5. **Bounded memory:** the file is read as a stream, one bounded buffer at a
   time, never loaded into memory as a whole (a recording can be 4 GB).
6. **Order:** the verification (with the MP4 inspection) completes
   successfully **before** the database transition to `READY`. That
   transition is a conditional update that applies only while the recording is
   still `VERIFYING` and the completion claim is still the active one. A
   failed or interrupted verification never leads to `READY`.

What verification does **not** do: it checks the file's contents at the
moment they are read. It does **not** prevent a write that happens after
verification (for example a stale writer from another process). Protection
against such writes comes from the claim-specific paths above, the
single-writer requirement and, within the one process, the upload mutex,
which is held through verification, promotion and the transition to `READY`.

## Student access and playback (RL-4.2, RL-4.3)

Routes (outside the middleware matcher; each authenticates with `requireStudentSession()`):

| Route | Purpose |
|---|---|
| `GET /api/student/recorded-lectures?scope=all\|dashboard&lectureId=&cursor=&limit=` | List (keyset pages: lecture date desc, lecture id, part, id) |
| `GET /api/student/recorded-lectures/[recordingId]` | Metadata (allow-list DTO, `streamUrl`) |
| `GET` / `HEAD /api/student/recorded-lectures/[recordingId]/stream` | Playback: 200 / 206 / 416, `video/mp4` |

**Authorisation, every request** (every Range request of a player): one filter,
`studentRecordedLectureAccessWhere()` in `services/recorded-lecture-student-service.ts`:
approved active student, active enrollment, active class and lecture, recording
`status 0`, `READY`, stored file name present. Missing and not-allowed are the same
404. The dashboard window (`RECORDED_LECTURE_DASHBOARD_DAYS`) only sets the dashboard
flag / `scope=dashboard`; it never limits the list, metadata or playback.

**Playback headers:** `private, no-store`, `nosniff`, `inline; filename="recording.mp4"`,
`Cross-Origin-Resource-Policy: same-origin`, `X-Accel-Buffering: no` (nginx streams
instead of spooling the video to its temporary files). No `ETag` / `Last-Modified`;
a request with `If-Range` therefore gets the whole file (200), as RFC 9110 requires.

**Stream slots** (`lib/recorded-lectures/stream-slots.ts`, constants, no settings):
4 concurrent bodies per student (429 `STREAM_LIMIT_REACHED`) and 64 per process
(503 `STREAMING_BUSY`), both with `Retry-After: 5`. A slot is taken only after
authorisation and only when a body is really streamed (never for HEAD, 404, 416 or
errors), and released exactly once when the body ends, the client disconnects, the
body is cancelled, a read fails, or it is idle for 120 s (no pull: a paused player or
a body never consumed; the player re-requests its range).

**Single process.** The slot counts are in memory. Production runs ONE Next.js
process (PM2 fork mode, one instance), so they are the real limits. With several
processes each would count separately (the per-student limit would become per
student per process).

**Integrity.** A READY recording whose file is missing, has another size than
`sizeBytes`, or cannot be opened safely (symlink, hard link) answers 500
`RECORDING_FILE_UNAVAILABLE`; the log names the recording id and storage error code
only. The opened storage is cached per process (`getRecordedLectureStorage()`);
only a `ROOT_*` error or invalid settings drop it. A root moved or re-pointed while
the server runs is picked up after a restart.

## Teacher management, upload UI and Recording Studio

Pages (teacher only; data loaded through the same ownership-checked service as the API):

| Page | Purpose |
|---|---|
| `/dashboard/lectures/[lectureId]/recordings` | Parts of a lecture: upload, progress, pause / resume / retry / cancel, edit title and part number, owner preview, delete |
| `/dashboard/lectures/[lectureId]/recordings/studio` | Browser Recording Studio |

The lecture card in `lecture-management-panel.tsx` links to the first page ("Recorded lectures").

APIs added (the upload protocol itself is unchanged RL-3):

| Route | Purpose |
|---|---|
| `GET /api/lectures/[id]/recorded-lectures` | The teacher's parts of the lecture (every state, upload progress, `nextPartNumber`, limits) |
| `PATCH /api/recorded-lectures/[recordingId]` | `{ title?, partNumber? }`; 409 `PART_NUMBER_IN_USE` (the partial unique index decides) |
| `DELETE /api/recorded-lectures/[recordingId]` | Soft delete (status 2, purge pending); an active upload is cancelled first; 409 while verifying |
| `GET` / `HEAD /api/recorded-lectures/[recordingId]/stream` | Owner preview of a READY part (same streaming code as students, slots under `teacher:<id>`) |

**Deleted files stay on disk.** Status 2 means "purge pending"; no purge step exists yet (and the maintenance scheduler is not enabled). Students never see status <> 0.

**Upload engine** (`components/recorded-lectures/upload-engine.ts`): sends the file in slices of the server's `chunkBytes` (never the whole file in memory), reports only server-acknowledged bytes, resumes from `status.receivedBytes`, retries transient errors with backoff, pauses after repeated network failures, sends `complete` once (duplicate-completion answers are treated as "verifying"), polls until READY / FAILED.

**Browser MP4 check.** Before uploading, the page runs the server's own `inspectMp4` on the file (and the studio on its recording), so a file the server would reject is refused before any byte is sent.

**Recording Studio.** MediaRecorder with an explicit MP4 H.264 + AAC type only (no server transcoding): desktop Chrome / Edge (recent) and Safari; Firefox records WebM only and is told to use another browser or upload an MP4. Modes: camera + microphone, screen + microphone, camera only (with a silent audio track; the server requires AAC audio). Camera + screen composition is NOT offered (canvas capture is throttled in background tabs; unverified). Nothing is uploaded before the teacher reviews the recording.

**Fragmented MP4 duration.** MediaRecorder writes fragmented MP4 whose length is unknown while recording (no mvhd / mehd duration). `mp4-inspect.ts` now computes the duration of such files from their last fragments (tfdt + trun / tfhd / trex sample durations, per track timescale); bounded to the last 32 fragments. Tested with synthetic files only: real MediaRecorder output must be verified in browsers.

**Recovery (best effort, not guaranteed).** Studio timeslices are stored in IndexedDB as they are recorded; an interrupted recording is offered again, trimmed to its last complete fragment and checked before saving. The upload id is stored with the recording so a refresh resumes the same upload. For file uploads only a fingerprint is stored (name, size, SHA-256 of the first and last MiB): after a refresh the teacher re-selects the same file. Browser storage can be cleared or evicted; private windows may not keep it.
