-- CreateEnum
CREATE TYPE "TeachingLevel" AS ENUM ('PRIMARY', 'OL', 'AL');

-- DropIndex
DROP INDEX "TeacherProfileSubject_profileId_subjectId_key";

-- AlterTable
ALTER TABLE "TeacherProfileSubject" ADD COLUMN "teachingLevel" "TeachingLevel";

-- Convert each existing grade range into one row per overlapping level
-- (PRIMARY = grades 1-5, OL = grades 6-11, AL = grades 12-13).
-- A row without a grade range is treated as teaching every level.
INSERT INTO "TeacherProfileSubject" ("id", "profileId", "subjectId", "gradeFrom", "gradeTo", "teachingLevel")
SELECT gen_random_uuid()::text, t."profileId", t."subjectId", t."gradeFrom", t."gradeTo", l."level"::"TeachingLevel"
FROM "TeacherProfileSubject" t
CROSS JOIN (VALUES ('PRIMARY', 1, 5), ('OL', 6, 11), ('AL', 12, 13)) AS l("level", "lo", "hi")
WHERE t."teachingLevel" IS NULL
  AND COALESCE(t."gradeFrom", 1) <= l."hi"
  AND COALESCE(t."gradeTo", 13) >= l."lo";

DELETE FROM "TeacherProfileSubject" WHERE "teachingLevel" IS NULL;

-- AlterTable
ALTER TABLE "TeacherProfileSubject" DROP COLUMN "gradeFrom",
DROP COLUMN "gradeTo",
ALTER COLUMN "teachingLevel" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfileSubject_profileId_subjectId_teachingLevel_key" ON "TeacherProfileSubject"("profileId", "subjectId", "teachingLevel");
