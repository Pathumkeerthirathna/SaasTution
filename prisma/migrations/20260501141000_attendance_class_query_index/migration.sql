CREATE INDEX IF NOT EXISTS "Attendance_classId_joinedAt_idx"
ON "Attendance"("classId", "joinedAt");
