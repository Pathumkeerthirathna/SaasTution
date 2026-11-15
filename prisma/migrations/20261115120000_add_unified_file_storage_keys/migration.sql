-- ---------------------------------------------------------------------------
-- Unified file storage (Stage 2): storage keys and SHA-256 digests for
-- Lecture Notes and student assignment submissions.
--
-- Additive only: two NULLABLE columns on "Note" and on
-- "AssignmentSubmission", one unique index each, CHECK constraints, and one
-- trigger function with a BEFORE UPDATE trigger per table. No
-- existing column (fileUrl stays NOT NULL and unchanged), index, constraint,
-- table or row is changed or dropped. Existing rows get NULL in both columns
-- and keep being read from their legacy fileUrl. Adding nullable columns
-- without a default is a catalog-only change (no table rewrite); the CHECKs
-- scan the table once, and every existing row passes them (both columns NULL).
--
-- Parts marked MANUAL are hand-written; the rest is exactly what
-- `prisma migrate diff` generates for the schema change. Guarded by
-- tests/storage-migration/migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- MANUAL: ALTER TABLE takes an exclusive lock; give up after 5 s instead of
-- queueing behind a long transaction (and blocking the tables meanwhile). The
-- migration can then simply be re-run.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "sha256" CHAR(64),
ADD COLUMN     "storageKey" VARCHAR(512);

-- AlterTable
ALTER TABLE "AssignmentSubmission" ADD COLUMN     "sha256" CHAR(64),
ADD COLUMN     "storageKey" VARCHAR(512);

-- CreateIndex
CREATE UNIQUE INDEX "Note_storageKey_key" ON "Note"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentSubmission_storageKey_key" ON "AssignmentSubmission"("storageKey");

-- MANUAL: CHECK constraints. (A CHECK whose expression is NULL passes, so
-- rows with NULL keys / digests are unaffected.)
--   *_sha256_format:            64 lowercase hexadecimal characters.
--   *_storageKey_format:        the exact key layouts of lib/notes/storage-keys.ts
--                               and lib/assignments/submission-keys.ts (relative,
--                               no "..", no absolute path, server-generated name).
--   *_storageKey_requires_sha256: a file in the new storage always has its digest.
ALTER TABLE "Note"
  ADD CONSTRAINT "Note_sha256_format"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Note_storageKey_format"
    CHECK ("storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Lectures/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Notes/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[0-9a-f]{32}\.(pdf|png|jpg|webp|docx|doc|pptx|ppt|xlsx|xls|txt|zip)$'),
  ADD CONSTRAINT "Note_storageKey_requires_sha256"
    CHECK ("storageKey" IS NULL OR "sha256" IS NOT NULL);

ALTER TABLE "AssignmentSubmission"
  ADD CONSTRAINT "AssignmentSubmission_sha256_format"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "AssignmentSubmission_storageKey_format"
    CHECK ("storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Lectures/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Assignments/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Submissions/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[0-9a-f]{32}\.pdf$'),
  ADD CONSTRAINT "AssignmentSubmission_storageKey_requires_sha256"
    CHECK ("storageKey" IS NULL OR "sha256" IS NOT NULL);

-- MANUAL: keep storageKey consistent with fileUrl across application versions
-- (Stage 2.1, rollback window). The previous application version knows only
-- fileUrl: its resubmission (an upsert) replaces fileUrl and leaves
-- storageKey / sha256 untouched, which would leave this version reading the
-- REPLACED file. Any UPDATE that changes "fileUrl" while leaving "storageKey"
-- as it was therefore clears "storageKey" and "sha256", so the row becomes a
-- plain legacy row that every version reads from fileUrl. This version always
-- changes both together (every upload has a new key), and a later copy into
-- the new storage sets storageKey without touching fileUrl, so neither is
-- affected. BEFORE UPDATE row triggers also run for INSERT ... ON CONFLICT DO
-- UPDATE. EXECUTE PROCEDURE is accepted by every supported PostgreSQL version.
CREATE FUNCTION "unified_storage_clear_stale_storage_key"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl" AND NEW."storageKey" IS NOT DISTINCT FROM OLD."storageKey" THEN
    NEW."storageKey" := NULL;
    NEW."sha256" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Note_clear_stale_storage_key"
  BEFORE UPDATE OF "fileUrl" ON "Note"
  FOR EACH ROW EXECUTE PROCEDURE "unified_storage_clear_stale_storage_key"();

CREATE TRIGGER "AssignmentSubmission_clear_stale_storage_key"
  BEFORE UPDATE OF "fileUrl" ON "AssignmentSubmission"
  FOR EACH ROW EXECUTE PROCEDURE "unified_storage_clear_stale_storage_key"();

-- MANUAL: restore the default lock timeout for the rest of the session.
RESET lock_timeout;
