-- DropIndex
DROP INDEX "Assignment_lectureId_dueDate_idx";

-- DropIndex
DROP INDEX "Lecture_classId_date_idx";

-- DropIndex
DROP INDEX "Note_lectureId_idx";

-- DropIndex
DROP INDEX "Quiz_lectureId_idx";

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Lecture" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Quiz" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Assignment_lectureId_status_dueDate_idx" ON "Assignment"("lectureId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Lecture_classId_status_date_idx" ON "Lecture"("classId", "status", "date");

-- CreateIndex
CREATE INDEX "Note_lectureId_status_idx" ON "Note"("lectureId", "status");

-- CreateIndex
CREATE INDEX "Quiz_lectureId_status_idx" ON "Quiz"("lectureId", "status");
