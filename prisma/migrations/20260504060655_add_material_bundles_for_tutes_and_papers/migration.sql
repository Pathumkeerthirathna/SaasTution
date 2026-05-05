-- CreateEnum
CREATE TYPE "MaterialBundleStatus" AS ENUM ('DRAFT', 'SENT');

-- CreateEnum
CREATE TYPE "MaterialBundleItemType" AS ENUM ('TUTE', 'PAPER');

-- CreateTable
CREATE TABLE "MaterialBundle" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "MaterialBundleStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "type" "MaterialBundleItemType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileName" TEXT,
    "fileUrl" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "paperStartAt" TIMESTAMP(3),
    "paperEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialBundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBundleRecipient" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "willReceive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialBundleRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialBundle_classId_year_month_idx" ON "MaterialBundle"("classId", "year", "month");

-- CreateIndex
CREATE INDEX "MaterialBundle_status_sentAt_idx" ON "MaterialBundle"("status", "sentAt");

-- CreateIndex
CREATE INDEX "MaterialBundleItem_bundleId_type_createdAt_idx" ON "MaterialBundleItem"("bundleId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialBundleRecipient_studentId_willReceive_idx" ON "MaterialBundleRecipient"("studentId", "willReceive");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialBundleRecipient_bundleId_studentId_key" ON "MaterialBundleRecipient"("bundleId", "studentId");

-- AddForeignKey
ALTER TABLE "MaterialBundle" ADD CONSTRAINT "MaterialBundle_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleItem" ADD CONSTRAINT "MaterialBundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "MaterialBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleRecipient" ADD CONSTRAINT "MaterialBundleRecipient_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "MaterialBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleRecipient" ADD CONSTRAINT "MaterialBundleRecipient_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
