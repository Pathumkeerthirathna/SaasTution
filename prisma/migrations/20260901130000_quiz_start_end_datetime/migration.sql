-- Quiz: replace the single optional `dueDate` with a required
-- `startDateTime` / `endDateTime` window, and add createdAt/updatedAt.

-- AlterTable: add the new columns nullable first so we can backfill.
ALTER TABLE "Quiz" ADD COLUMN "startDateTime" TIMESTAMP(3);
ALTER TABLE "Quiz" ADD COLUMN "endDateTime" TIMESTAMP(3);
ALTER TABLE "Quiz" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Quiz" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows from the old dueDate (or createdAt as a fallback).
UPDATE "Quiz" SET
  "startDateTime" = COALESCE("dueDate" - INTERVAL '7 days', "createdAt"),
  "endDateTime"   = COALESCE("dueDate", "createdAt" + INTERVAL '7 days');

-- Guard against any row where the computed window is empty/inverted.
UPDATE "Quiz" SET "endDateTime" = "startDateTime" + INTERVAL '1 day'
WHERE "endDateTime" <= "startDateTime";

-- Now that every row has a value, make the columns required.
ALTER TABLE "Quiz" ALTER COLUMN "startDateTime" SET NOT NULL;
ALTER TABLE "Quiz" ALTER COLUMN "endDateTime" SET NOT NULL;

-- Drop the column this replaces.
ALTER TABLE "Quiz" DROP COLUMN "dueDate";
