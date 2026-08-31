-- AlterTable
ALTER TABLE "MaterialBundle" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MaterialBundleItem" ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "MaterialBundle_classId_status_idx" ON "MaterialBundle"("classId", "status");

-- CreateIndex
CREATE INDEX "MaterialBundleItem_bundleId_status_idx" ON "MaterialBundleItem"("bundleId", "status");
