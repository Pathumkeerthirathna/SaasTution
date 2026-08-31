-- DropIndex
DROP INDEX "TeacherCalendarEvent_teacherId_startDateTime_idx";

-- AlterTable
ALTER TABLE "TeacherCalendarEvent" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "TeacherCalendarEvent_teacherId_status_startDateTime_idx" ON "TeacherCalendarEvent"("teacherId", "status", "startDateTime");
