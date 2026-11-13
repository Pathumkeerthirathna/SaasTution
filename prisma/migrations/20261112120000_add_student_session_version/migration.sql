-- ---------------------------------------------------------------------------
-- Student session version (Student Profile SP-5.2).
--
-- Additive only: one column on "Student". No existing column, index (including
-- the manual partial unique index "Student_registrationNumber_not_deleted_key"),
-- constraint, table or row is changed or dropped. Existing rows get 0, the same
-- value an existing student JWT without an "sv" claim is treated as, so no
-- current session is invalidated by this migration.
--
-- On PostgreSQL 11+ adding a column with a constant default is a catalog-only
-- change (no table rewrite). Guarded by
-- tests/students/session-version-migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Student" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
