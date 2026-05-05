-- Allow multiple assignment/removal cycles per student/class pair.
-- Keep active-state enforcement in application logic.
DROP INDEX IF EXISTS "ClassStudent_classId_studentId_isActive_key";
