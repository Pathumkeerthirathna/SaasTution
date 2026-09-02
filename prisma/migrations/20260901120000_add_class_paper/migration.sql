-- CreateTable
CREATE TABLE "ClassPaper" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pdfName" TEXT NOT NULL,
    "pdfUrl" TEXT NOT NULL,
    "pdfMimeType" TEXT NOT NULL,
    "maxMarks" DECIMAL(65,30),
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassPaperStudent" (
    "id" TEXT NOT NULL,
    "classPaperId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "submitted" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "submissionPdfUrl" TEXT,
    "submissionFileName" TEXT,
    "submissionMimeType" TEXT,
    "marks" DECIMAL(65,30),
    "markedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassPaperStudent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassPaper_classId_status_idx" ON "ClassPaper"("classId", "status");

-- CreateIndex
CREATE INDEX "ClassPaper_startTime_endTime_idx" ON "ClassPaper"("startTime", "endTime");

-- CreateIndex
CREATE INDEX "ClassPaperStudent_studentId_idx" ON "ClassPaperStudent"("studentId");

-- CreateIndex
CREATE INDEX "ClassPaperStudent_classPaperId_idx" ON "ClassPaperStudent"("classPaperId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassPaperStudent_classPaperId_studentId_key" ON "ClassPaperStudent"("classPaperId", "studentId");

-- AddForeignKey
ALTER TABLE "ClassPaper" ADD CONSTRAINT "ClassPaper_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPaperStudent" ADD CONSTRAINT "ClassPaperStudent_classPaperId_fkey" FOREIGN KEY ("classPaperId") REFERENCES "ClassPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPaperStudent" ADD CONSTRAINT "ClassPaperStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
