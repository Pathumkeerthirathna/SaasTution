-- AlterTable
ALTER TABLE "Quiz" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER;

-- AlterTable
ALTER TABLE "QuizSubmission" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 1;
