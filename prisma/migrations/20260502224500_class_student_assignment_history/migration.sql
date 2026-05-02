ALTER TABLE "ClassStudent"
ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "removeReason" TEXT;

DROP INDEX IF EXISTS "ClassStudent_classId_studentId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ClassStudent_classId_studentId_isActive_key"
ON "ClassStudent"("classId", "studentId", "isActive");

CREATE INDEX IF NOT EXISTS "ClassStudent_classId_isActive_idx"
ON "ClassStudent"("classId", "isActive");
