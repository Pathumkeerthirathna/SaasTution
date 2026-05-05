-- CreateTable
CREATE TABLE "MaterialBundleItemSubmission" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialBundleItemSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialBundleItemSubmission_itemId_studentId_submittedAt_idx" ON "MaterialBundleItemSubmission"("itemId", "studentId", "submittedAt");

-- CreateIndex
CREATE INDEX "MaterialBundleItemSubmission_studentId_submittedAt_idx" ON "MaterialBundleItemSubmission"("studentId", "submittedAt");

-- AddForeignKey
ALTER TABLE "MaterialBundleItemSubmission" ADD CONSTRAINT "MaterialBundleItemSubmission_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaterialBundleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleItemSubmission" ADD CONSTRAINT "MaterialBundleItemSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
