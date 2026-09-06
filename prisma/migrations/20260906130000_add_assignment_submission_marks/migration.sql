-- Adds teacher-assigned marks to assignment submissions.
ALTER TABLE "AssignmentSubmission"
  ADD COLUMN "marks" INTEGER;
