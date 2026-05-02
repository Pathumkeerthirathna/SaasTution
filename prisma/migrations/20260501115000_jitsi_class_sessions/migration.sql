CREATE TABLE "ClassSession" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "jitsiDomain" TEXT NOT NULL DEFAULT 'meet.jit.si',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassSession_roomName_key" ON "ClassSession"("roomName");
CREATE INDEX "ClassSession_classId_isActive_idx" ON "ClassSession"("classId", "isActive");

ALTER TABLE "Attendance"
ADD COLUMN "classSessionId" TEXT,
ADD COLUMN "leftAt" TIMESTAMP(3);

UPDATE "Attendance"
SET "classSessionId" = (
  SELECT cs."id"
  FROM "ClassSession" cs
  WHERE cs."classId" = "Attendance"."classId"
  ORDER BY cs."startedAt" DESC
  LIMIT 1
);

DELETE FROM "Attendance" WHERE "classSessionId" IS NULL;

ALTER TABLE "Attendance"
ALTER COLUMN "classSessionId" SET NOT NULL;

CREATE INDEX "Attendance_classSessionId_idx" ON "Attendance"("classSessionId");
CREATE UNIQUE INDEX "Attendance_classSessionId_studentId_key" ON "Attendance"("classSessionId", "studentId");

ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_classId_fkey"
FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_classSessionId_fkey"
FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
