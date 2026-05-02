ALTER TABLE "Student"
ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;

-- Backfill one registration number per student from existing class assignments when available.
WITH ranked_registration AS (
  SELECT
    "studentId",
    "registrationNumber",
    ROW_NUMBER() OVER (PARTITION BY "studentId" ORDER BY "id" ASC) AS rn
  FROM "ClassStudent"
  WHERE "registrationNumber" IS NOT NULL
)
UPDATE "Student" s
SET "registrationNumber" = rr."registrationNumber"
FROM ranked_registration rr
WHERE rr.rn = 1
  AND s."id" = rr."studentId"
  AND s."registrationNumber" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Student_registrationNumber_key"
ON "Student"("registrationNumber");

DROP INDEX IF EXISTS "ClassStudent_registrationNumber_key";
ALTER TABLE "ClassStudent"
DROP COLUMN IF EXISTS "registrationNumber";
