DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'QuizAnswerType'
  ) THEN
    CREATE TYPE "QuizAnswerType" AS ENUM ('SINGLE', 'MULTIPLE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "QuizQuestion" (
  "id" TEXT NOT NULL,
  "quizId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QuizQuestionOption" (
  "id" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "isCorrect" BOOLEAN NOT NULL DEFAULT false,
  "orderIndex" INTEGER NOT NULL,
  CONSTRAINT "QuizQuestionOption_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "QuizQuestion"
ADD COLUMN IF NOT EXISTS "answerType" "QuizAnswerType" NOT NULL DEFAULT 'SINGLE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'QuizQuestion_quizId_fkey'
      AND table_name = 'QuizQuestion'
  ) THEN
    ALTER TABLE "QuizQuestion"
    ADD CONSTRAINT "QuizQuestion_quizId_fkey"
    FOREIGN KEY ("quizId") REFERENCES "Quiz"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'QuizQuestionOption_questionId_fkey'
      AND table_name = 'QuizQuestionOption'
  ) THEN
    ALTER TABLE "QuizQuestionOption"
    ADD CONSTRAINT "QuizQuestionOption_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "QuizQuestion_quizId_orderIndex_idx"
ON "QuizQuestion"("quizId", "orderIndex");

CREATE INDEX IF NOT EXISTS "QuizQuestionOption_questionId_orderIndex_idx"
ON "QuizQuestionOption"("questionId", "orderIndex");
