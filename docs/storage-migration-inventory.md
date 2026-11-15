# Unified storage migration, Stage 1: inventory

A read-only tool that records the baseline before Notes and assignment submissions move into
`FILE_STORAGE_ROOT/Teachers/{teacherId}/Lectures/{lectureId}/...`. It changes nothing: no file is moved, renamed,
created or deleted in the inspected folders, and no database row is written.

## What it reads

| Data | Where the current app keeps it |
|---|---|
| `Note.fileUrl` (`lectures/{lectureId}/{file}`) | `<app>/storage/lectures/...` |
| `Note.fileUrl` starting with `/uploads/` (legacy; nothing writes it today) | `<app>/public/uploads/...` |
| `AssignmentSubmission.fileUrl` (`assignments/{assignmentId}/{file}`) | `<app>/storage/assignments/...` |

Since Stage 2.1 it also reads the new storage:

| Data | Where |
|---|---|
| `storageKey`, `sha256` (Notes and submissions) | `FILE_STORAGE_ROOT/Teachers/.../Notes/...` and `.../Assignments/.../Submissions/...` |

Ownership: Note → Lecture → Class.teacherId; AssignmentSubmission → Assignment → Lecture → Class.teacherId.
Soft-deleted notes (`status != 0`), and records under removed lectures, classes or assignments, are included.

## Running it

Use a **local, disposable** PostgreSQL that holds a copy of the data, and a **copy** of the legacy folders.

```sh
STORAGE_INVENTORY_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:5432/slc_inventory_test' \
npm run storage:inventory -- \
  --storage-root=/abs/path/to/copy/storage \
  --public-uploads-root=/abs/path/to/copy/public/uploads \
  --file-storage-root=/abs/path/to/copy/file-storage \
  --out=/abs/path/to/reports/inventory-2026-11-15.json \
  --confirm-database=slc_inventory_test
```

On Windows PowerShell, set the variable first: `$env:STORAGE_INVENTORY_DATABASE_URL = '...'`.

`--public-uploads-root` is optional. Without it, `/uploads/` references are reported as `UPLOADS_ROOT_NOT_CONFIGURED`.

`--file-storage-root` (a copy of `FILE_STORAGE_ROOT`) is optional. Without it, records that have a `storageKey` are reported as `NEW_STORAGE_ROOT_NOT_CONFIGURED`, and the console says the new storage was not verified.

Output:
- `<out>.json`, the full machine-readable report.
- `<out>.summary.txt`, a readable summary with per-teacher totals and the records to investigate.
- The console shows counts only: no ids, paths or credentials.

Exit codes: `0` report written, `1` refused or failed (nothing written), `2` usage error.

## Safeguards

Database:
- The URL comes from `STORAGE_INVENTORY_DATABASE_URL` only. `DATABASE_URL` and `.env` are never used. Prisma loads `.env` when the client is constructed, so every variable it adds is removed straight away.
- The host must be `localhost`, `127.0.0.1` or `::1`.
- The database name must contain `test`, `testing`, `dev`, `development` or `local` as a separate word.
- No other host, no multiple hosts, and no URL parameter other than `schema`, `connect_timeout`, `sslmode` or `application_name`.
- `--confirm-database` must repeat the database name.
- All reads run in one `REPEATABLE READ, READ ONLY` transaction, which is verified with `SHOW`. PostgreSQL itself rejects any write. Only `findMany` can be reached.
- Errors are printed by name or code only.

Filesystem:
- Only the given roots are read. Each root must be an absolute, existing directory that is neither a link nor reached through one, and the roots must not overlap.
- Every path component is checked with `lstat`, so links are never followed. Files are opened read-only, and the opened file must be the one `lstat` saw.
- The scan for unreferenced files covers `storage/lectures`, `storage/assignments`, and the new storage's `Teachers/` tree.
- In the new storage, `Teachers/*/Lectures/*/RecordedLectures` (Recorded Lectures) and `System/` are never entered.
- Other features' legacy folders and `public/uploads` are not scanned.
- The only files written are the two reports. Each is created exclusively (never overwritten), outside the roots, in a folder that already exists.

## Reading the report

Physical files are identified by device and inode, so hard links and different spellings of the same path count as one file.
- Bytes are counted once per physical file.
- A file referenced by records of different teachers is counted for nobody and listed under `ownershipConflicts`.
- `contentDigest` is the same for two runs over unchanged data.

Every record has a `storageState`:
- `LEGACY`: no `storageKey`.
- `MIGRATED`: the new-storage file exists with the database size and SHA-256.
- `MIGRATED_WITH_PROBLEMS`: anything else.

A stored record's `legacyRole`:
- `NONE`: `fileUrl` equals `storageKey`.
- `ROLLBACK_COPY`: the dual-write copy paired with the key.
- `RETAINED_ORIGINAL`: any other `fileUrl`.

Unreferenced new-storage files are listed under `unreferencedNewStorageFiles`. `bytesByLocation` and the per-teacher `legacyBytes` / `newStorageBytes` split the totals.

Record issues that need investigation:

| Issue | Meaning |
|---|---|
| `FILE_MISSING` | The referenced file does not exist |
| `SIZE_MISMATCH` | The file's size differs from the size in the database |
| `DUPLICATE_REFERENCE` | Another record references the same physical file (or the same missing path) |
| `UNSAFE_PATH` / `INVALID_REFERENCE` | The reference escapes its root, or is empty or contains NUL. It is not inspected. |
| `SYMLINK_IN_PATH`, `NOT_A_REGULAR_FILE`, `PATH_COMPONENT_NOT_DIRECTORY` | Something unexpected sits on the path |
| `READ_ERROR`, `FILE_CHANGED_DURING_READ` | The file could not be read cleanly |
| `UNUSUAL_REFERENCE` | Backslashes, `.`/`..` segments, an absolute path or an unexpected prefix. The app still resolves it as recorded. |
| `FOLDER_MISMATCH` | The file sits in another lecture's or assignment's folder |
| `OWNERSHIP_UNKNOWN` | No teacher could be determined |
| `UPLOADS_ROOT_NOT_CONFIGURED` | A `/uploads/` reference, but no public uploads root was given |
| `INVALID_STORAGE_KEY` | The key is not a valid key of this record's kind. It is never opened. |
| `DESTINATION_MISSING` / `DESTINATION_UNREADABLE` | The new-storage file is missing, or is a link or other unsafe entry |
| `DESTINATION_SIZE_MISMATCH` / `DESTINATION_HASH_MISMATCH` | The new-storage file differs from the database size or `sha256` |
| `DESTINATION_HASH_UNRECORDED` | A key without a digest (the database CHECK forbids this) |
| `DESTINATION_OWNER_MISMATCH` | The key is not under the record's own teacher, lecture or assignment and record id |
| `NEW_STORAGE_ROOT_NOT_CONFIGURED` | The record has a key, but no `--file-storage-root` was given |
| `LEGACY_COPY_MISSING` / `LEGACY_COPY_HASH_MISMATCH` | A rollback copy or retained original is missing or not identical. Rollback safety or retention is broken. |

`LEGACY_UPLOADS_REFERENCE` is informational only.

## Tests

- `npm run test:storage-migration` runs on temporary folders with an in-memory database fake.
- `npm run test:storage-migration-db` is skipped unless `STORAGE_INVENTORY_TEST_DATABASE_URL` points at a local test database with the migration applied. It proves:
  - PostgreSQL rejects writes inside the read-only transaction;
  - the migration's trigger and CHECKs behave as documented. These checks run only inside transactions that are rolled back.
