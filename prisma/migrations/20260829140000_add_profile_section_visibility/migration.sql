-- AlterTable
ALTER TABLE "TeacherProfile"
    ADD COLUMN "isDisplayQualification" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "isDisplayAchievements" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "isDisplaySubjects" BOOLEAN NOT NULL DEFAULT true;
