-- CreateEnum
CREATE TYPE "TeacherProfileSectionType" AS ENUM ('ABOUT_ME', 'ANNOUNCEMENTS', 'SUBJECTS', 'SOCIAL_MEDIA', 'QUALIFICATIONS', 'ACHIEVEMENTS');

-- CreateTable
CREATE TABLE "TeacherProfileSection" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "sectionType" "TeacherProfileSectionType" NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherProfileSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherProfileSection_teacherId_idx" ON "TeacherProfileSection"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfileSection_teacherId_sectionType_key" ON "TeacherProfileSection"("teacherId", "sectionType");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfileSection_teacherId_displayOrder_key" ON "TeacherProfileSection"("teacherId", "displayOrder");

-- AddForeignKey
ALTER TABLE "TeacherProfileSection" ADD CONSTRAINT "TeacherProfileSection_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
