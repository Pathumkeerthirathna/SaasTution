-- CreateEnum
CREATE TYPE "BreakoutTargetRoomType" AS ENUM ('MAIN', 'BREAKOUT');

-- CreateEnum
CREATE TYPE "BreakoutActivityState" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BreakoutQuizAttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED');

-- CreateTable
CREATE TABLE "BreakoutAssignment" (
    "id" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "publishGroupId" TEXT,
    "targetRoomType" "BreakoutTargetRoomType" NOT NULL,
    "targetRoomId" TEXT,
    "targetRoomName" VARCHAR(120) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "instructions" TEXT NOT NULL,
    "briefFileName" VARCHAR(200),
    "briefFilePath" TEXT,
    "briefFileSize" INTEGER,
    "state" "BreakoutActivityState" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "status" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakoutAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutAssignmentDraft" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "answerText" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakoutAssignmentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutAssignmentSubmission" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "answerText" TEXT,
    "fileName" VARCHAR(200),
    "filePath" TEXT,
    "fileSize" INTEGER,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakoutAssignmentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutQuiz" (
    "id" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "publishGroupId" TEXT,
    "targetRoomType" "BreakoutTargetRoomType" NOT NULL,
    "targetRoomId" TEXT,
    "targetRoomName" VARCHAR(120) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "instructions" TEXT,
    "questions" JSONB NOT NULL,
    "totalMarks" DECIMAL(7,2) NOT NULL,
    "timeLimitSeconds" INTEGER,
    "state" "BreakoutActivityState" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "status" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakoutQuiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakoutQuizSubmission" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptStatus" "BreakoutQuizAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "lastSavedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "grading" JSONB,
    "autoScore" DECIMAL(7,2),
    "finalScore" DECIMAL(7,2),
    "overriddenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakoutQuizSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BreakoutAssignment_classSessionId_targetRoomType_targetRoom_idx" ON "BreakoutAssignment"("classSessionId", "targetRoomType", "targetRoomId", "state");

-- CreateIndex
CREATE INDEX "BreakoutAssignment_classSessionId_createdAt_idx" ON "BreakoutAssignment"("classSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "BreakoutAssignment_publishGroupId_idx" ON "BreakoutAssignment"("publishGroupId");

-- CreateIndex
CREATE INDEX "BreakoutAssignmentDraft_classSessionId_idx" ON "BreakoutAssignmentDraft"("classSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BreakoutAssignmentDraft_assignmentId_studentId_key" ON "BreakoutAssignmentDraft"("assignmentId", "studentId");

-- CreateIndex
CREATE INDEX "BreakoutAssignmentSubmission_assignmentId_isLatest_idx" ON "BreakoutAssignmentSubmission"("assignmentId", "isLatest");

-- CreateIndex
CREATE INDEX "BreakoutAssignmentSubmission_classSessionId_idx" ON "BreakoutAssignmentSubmission"("classSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BreakoutAssignmentSubmission_assignmentId_studentId_version_key" ON "BreakoutAssignmentSubmission"("assignmentId", "studentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BreakoutAssignmentSubmission_assignmentId_studentId_idempot_key" ON "BreakoutAssignmentSubmission"("assignmentId", "studentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BreakoutQuiz_classSessionId_targetRoomType_targetRoomId_sta_idx" ON "BreakoutQuiz"("classSessionId", "targetRoomType", "targetRoomId", "state");

-- CreateIndex
CREATE INDEX "BreakoutQuiz_classSessionId_createdAt_idx" ON "BreakoutQuiz"("classSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "BreakoutQuiz_publishGroupId_idx" ON "BreakoutQuiz"("publishGroupId");

-- CreateIndex
CREATE INDEX "BreakoutQuizSubmission_quizId_attemptStatus_idx" ON "BreakoutQuizSubmission"("quizId", "attemptStatus");

-- CreateIndex
CREATE INDEX "BreakoutQuizSubmission_classSessionId_idx" ON "BreakoutQuizSubmission"("classSessionId");

-- CreateIndex
CREATE INDEX "BreakoutQuizSubmission_attemptStatus_deadlineAt_idx" ON "BreakoutQuizSubmission"("attemptStatus", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "BreakoutQuizSubmission_quizId_studentId_key" ON "BreakoutQuizSubmission"("quizId", "studentId");

-- AddForeignKey
ALTER TABLE "BreakoutAssignment" ADD CONSTRAINT "BreakoutAssignment_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignment" ADD CONSTRAINT "BreakoutAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignmentDraft" ADD CONSTRAINT "BreakoutAssignmentDraft_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "BreakoutAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignmentDraft" ADD CONSTRAINT "BreakoutAssignmentDraft_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignmentDraft" ADD CONSTRAINT "BreakoutAssignmentDraft_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignmentSubmission" ADD CONSTRAINT "BreakoutAssignmentSubmission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "BreakoutAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignmentSubmission" ADD CONSTRAINT "BreakoutAssignmentSubmission_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutAssignmentSubmission" ADD CONSTRAINT "BreakoutAssignmentSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutQuiz" ADD CONSTRAINT "BreakoutQuiz_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutQuiz" ADD CONSTRAINT "BreakoutQuiz_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutQuizSubmission" ADD CONSTRAINT "BreakoutQuizSubmission_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "BreakoutQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutQuizSubmission" ADD CONSTRAINT "BreakoutQuizSubmission_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakoutQuizSubmission" ADD CONSTRAINT "BreakoutQuizSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- MANUAL (not generated by Prisma). Prisma 5.22 cannot express partial
-- indexes, so this statement exists only here, never in schema.prisma.
-- Enforces at most one "isLatest" = true row per (assignmentId, studentId).
-- Never remove it. Any later migration containing
--   DROP INDEX "BreakoutAssignmentSubmission_one_latest_key"
-- is a bug: see docs/breakout-activities-migrations.md.
-- Guarded by tests/breakout-activities/migration-guard.test.cjs.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "BreakoutAssignmentSubmission_one_latest_key"
  ON "BreakoutAssignmentSubmission" ("assignmentId", "studentId")
  WHERE "isLatest";
