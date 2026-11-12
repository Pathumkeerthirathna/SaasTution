-- Stage 5.4b correction: QR attendance closure (docs/lecture-attendance.md,
-- "QR scanning window and closure").
--
-- Additive only: one new table, its primary key, two RESTRICT foreign keys
-- and two hand-written append-only triggers. No existing table, column, row,
-- constraint, trigger or function is changed. Not applied to any database.
--
-- Fails instead of waiting long behind another transaction (same rule as
-- 20261110140000_add_lecture_attendance): the two foreign keys take SHARE ROW
-- EXCLUSIVE on "LectureAttendanceRegister" and "Teacher" briefly.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "LectureQrAttendanceClosure" (
    "lectureId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedByTeacherId" TEXT NOT NULL,

    CONSTRAINT "LectureQrAttendanceClosure_pkey" PRIMARY KEY ("lectureId")
);

-- AddForeignKey
ALTER TABLE "LectureQrAttendanceClosure" ADD CONSTRAINT "LectureQrAttendanceClosure_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "LectureAttendanceRegister"("lectureId", "classId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureQrAttendanceClosure" ADD CONSTRAINT "LectureQrAttendanceClosure_closedByTeacherId_fkey" FOREIGN KEY ("closedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- MANUAL: a closure is permanent (no reopening in this version). The row is
-- written once and can never be changed or removed: it is both the closure
-- state and its audit record. Reuses the append-only guard function of
-- 20261110140000_add_lecture_attendance (not redefined here).
CREATE TRIGGER "LectureQrAttendanceClosure_no_update_delete"
  BEFORE UPDATE OR DELETE ON "LectureQrAttendanceClosure"
  FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"();
CREATE TRIGGER "LectureQrAttendanceClosure_no_truncate"
  BEFORE TRUNCATE ON "LectureQrAttendanceClosure"
  FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"();

RESET lock_timeout;
