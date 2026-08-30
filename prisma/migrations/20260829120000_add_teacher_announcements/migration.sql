-- CreateTable
CREATE TABLE "TeacherAnnouncement" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "imageName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherAnnouncement_teacherId_idx" ON "TeacherAnnouncement"("teacherId");

-- CreateIndex
CREATE INDEX "TeacherAnnouncement_teacherId_sortOrder_idx" ON "TeacherAnnouncement"("teacherId", "sortOrder");

-- AddForeignKey
ALTER TABLE "TeacherAnnouncement" ADD CONSTRAINT "TeacherAnnouncement_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
