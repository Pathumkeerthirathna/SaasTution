-- Adds review tracking to assignment submissions. reviewedAt = null means
-- the submission has not been reviewed/marked yet.
ALTER TABLE "AssignmentSubmission"
  ADD COLUMN "reviewedAt" TIMESTAMP(3);
