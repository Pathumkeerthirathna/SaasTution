-- Adds teacher-review tracking to bundle paper submissions.
-- reviewedAt = null means the submission has not been reviewed/marked yet.
ALTER TABLE "MaterialBundleItemSubmission"
  ADD COLUMN "marks" INTEGER,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);
