-- CreateTable
CREATE TABLE "TeacherPaperConfig" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "countdownLeadMinutes" INTEGER NOT NULL DEFAULT 30,
    "submissionGraceMinutes" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherPaperConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperSupportMessage" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperSupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherPaperConfig_teacherId_key" ON "TeacherPaperConfig"("teacherId");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_itemId_createdAt_idx" ON "PaperSupportMessage"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_studentId_createdAt_idx" ON "PaperSupportMessage"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_teacherId_createdAt_idx" ON "PaperSupportMessage"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_classId_createdAt_idx" ON "PaperSupportMessage"("classId", "createdAt");

-- AddForeignKey
ALTER TABLE "TeacherPaperConfig" ADD CONSTRAINT "TeacherPaperConfig_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "MaterialBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaterialBundleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
