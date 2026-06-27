-- CreateTable
CREATE TABLE "District" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" SERIAL NOT NULL,
    "districtId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherProfile" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "profileImageUrl" TEXT,
    "coverImageUrl" TEXT,
    "designation" TEXT,
    "headline" TEXT,
    "aboutMe" TEXT,
    "qualificationSummary" TEXT,
    "yearsOfExperience" INTEGER,
    "phone" TEXT,
    "whatsapp" TEXT,
    "districtId" INTEGER,
    "cityId" INTEGER,
    "facebookUrl" TEXT,
    "youtubeUrl" TEXT,
    "tiktokUrl" TEXT,
    "instagramUrl" TEXT,
    "websiteUrl" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "profileViewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Medium" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Medium_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherProfileMedium" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "mediumId" INTEGER NOT NULL,

    CONSTRAINT "TeacherProfileMedium_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherQualification" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "institute" TEXT NOT NULL,
    "startYear" INTEGER,
    "endYear" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TeacherQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherAchievement" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "year" INTEGER,

    CONSTRAINT "TeacherAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherProfileSubject" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "gradeFrom" INTEGER,
    "gradeTo" INTEGER,

    CONSTRAINT "TeacherProfileSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "District_name_key" ON "District"("name");

-- CreateIndex
CREATE UNIQUE INDEX "City_districtId_name_key" ON "City"("districtId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_teacherId_key" ON "TeacherProfile"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_slug_key" ON "TeacherProfile"("slug");

-- CreateIndex
CREATE INDEX "TeacherProfile_districtId_idx" ON "TeacherProfile"("districtId");

-- CreateIndex
CREATE INDEX "TeacherProfile_cityId_idx" ON "TeacherProfile"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "Medium_name_key" ON "Medium"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfileMedium_profileId_mediumId_key" ON "TeacherProfileMedium"("profileId", "mediumId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_name_key" ON "Subject"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfileSubject_profileId_subjectId_key" ON "TeacherProfileSubject"("profileId", "subjectId");

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfile" ADD CONSTRAINT "TeacherProfile_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfile" ADD CONSTRAINT "TeacherProfile_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfile" ADD CONSTRAINT "TeacherProfile_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfileMedium" ADD CONSTRAINT "TeacherProfileMedium_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfileMedium" ADD CONSTRAINT "TeacherProfileMedium_mediumId_fkey" FOREIGN KEY ("mediumId") REFERENCES "Medium"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherQualification" ADD CONSTRAINT "TeacherQualification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAchievement" ADD CONSTRAINT "TeacherAchievement_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfileSubject" ADD CONSTRAINT "TeacherProfileSubject_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfileSubject" ADD CONSTRAINT "TeacherProfileSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
