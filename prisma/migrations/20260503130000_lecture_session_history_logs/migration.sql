ALTER TABLE "ClassSession"
ADD COLUMN IF NOT EXISTS "lectureId" TEXT;

CREATE INDEX IF NOT EXISTS "ClassSession_lectureId_startedAt_idx"
ON "ClassSession"("lectureId", "startedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ClassSession_lectureId_fkey'
      AND table_name = 'ClassSession'
  ) THEN
    ALTER TABLE "ClassSession"
    ADD CONSTRAINT "ClassSession_lectureId_fkey"
    FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS "Attendance_classSessionId_studentId_key";

CREATE INDEX IF NOT EXISTS "Attendance_classSessionId_studentId_joinedAt_idx"
ON "Attendance"("classSessionId", "studentId", "joinedAt");
