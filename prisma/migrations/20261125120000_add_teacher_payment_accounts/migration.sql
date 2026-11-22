-- ---------------------------------------------------------------------------
-- Teacher payment accounts ("Payment Details" on the teacher profile).
--
-- Additive only: one new enum, one new table, one new defaulted column on
-- "TeacherProfile". No existing table, row or payment workflow (ClassPayment,
-- receipts, confirmations, gateways) is changed.
--
-- Parts marked MANUAL are hand-written; the rest is exactly what
-- `prisma migrate diff` generates for the schema change.
-- ---------------------------------------------------------------------------

-- MANUAL: give up after 5 s instead of queueing behind a long transaction
-- (ALTER TABLE takes an exclusive lock); the migration can then be re-run.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "TeacherPaymentAccountType" AS ENUM ('SAVINGS', 'CURRENT', 'OTHER');

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "isDisplayPaymentDetails" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "TeacherPaymentAccount" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "label" VARCHAR(60),
    "accountHolderName" VARCHAR(120) NOT NULL,
    "bankName" VARCHAR(120) NOT NULL,
    "branchName" VARCHAR(120),
    "accountNumber" VARCHAR(34) NOT NULL,
    "accountType" "TeacherPaymentAccountType" NOT NULL DEFAULT 'SAVINGS',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherPaymentAccount_teacherId_status_idx" ON "TeacherPaymentAccount"("teacherId", "status");

-- AddForeignKey
ALTER TABLE "TeacherPaymentAccount" ADD CONSTRAINT "TeacherPaymentAccount_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MANUAL: at most ONE primary account per teacher among the non-removed rows
-- (the service keeps at least one while any exist, inside a transaction).
CREATE UNIQUE INDEX "TeacherPaymentAccount_one_primary_per_teacher"
  ON "TeacherPaymentAccount"("teacherId")
  WHERE "isPrimary" AND "status" = 0;

-- MANUAL: CHECK constraints.
--   *_status_allowed:        0 = active, 1 = removed (soft delete).
--   *_removed_not_primary:   a removed row is never the primary account.
--   *_required_not_blank:    holder, bank and account number are not blank.
ALTER TABLE "TeacherPaymentAccount"
  ADD CONSTRAINT "TeacherPaymentAccount_status_allowed"
    CHECK ("status" IN (0, 1)),
  ADD CONSTRAINT "TeacherPaymentAccount_removed_not_primary"
    CHECK ("status" = 0 OR "isPrimary" = false),
  ADD CONSTRAINT "TeacherPaymentAccount_required_not_blank"
    CHECK (
      btrim("accountHolderName") <> ''
      AND btrim("bankName") <> ''
      AND btrim("accountNumber") <> ''
    );

-- MANUAL: restore the default lock timeout for the rest of the session.
RESET lock_timeout;
