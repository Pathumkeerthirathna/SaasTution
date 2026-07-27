/*
  Warnings:

  - A unique constraint covering the columns `[studentId,deviceId]` on the table `StudentDevice` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `StudentDevice` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "StudentDevice_deviceId_idx";

-- DropIndex
DROP INDEX "StudentDevice_deviceId_key";

-- AlterTable
ALTER TABLE "StudentDevice" ADD COLUMN     "approvalRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "approvedReason" TEXT,
ADD COLUMN     "deviceName" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "StudentDevice_approvedByTeacherId_idx" ON "StudentDevice"("approvedByTeacherId");

-- CreateIndex
CREATE INDEX "StudentDevice_approvalRequestedAt_idx" ON "StudentDevice"("approvalRequestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudentDevice_studentId_deviceId_key" ON "StudentDevice"("studentId", "deviceId");
