-- ---------------------------------------------------------------------------
-- Simplified student registration & first login: whether the student's
-- password is a system-generated temporary one whose optional "Secure Your
-- Account" step is still pending.
--
-- Additive only: one NOT NULL boolean with a constant default (a catalog-only
-- change on PostgreSQL 11+, no table rewrite). Every existing student gets
-- false, so no existing account is ever prompted; no password, session,
-- device or approval is changed.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "passwordSetupPending" BOOLEAN NOT NULL DEFAULT false;
