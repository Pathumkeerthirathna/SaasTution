-- CreateEnum
CREATE TYPE "StudentRegistrationSource" AS ENUM ('TEACHER', 'PUBLIC_CLASS', 'IMPORT', 'ADMIN');

-- CreateEnum
CREATE TYPE "StudentConfirmationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StudentDeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "LoginResult" AS ENUM ('SUCCESS', 'FAILED', 'BLOCKED_DEVICE', 'PENDING_DEVICE', 'INVALID_PASSWORD');

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "confirmationStatus" "StudentConfirmationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "publicClassId" TEXT,
ADD COLUMN     "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "registrationSource" "StudentRegistrationSource" NOT NULL DEFAULT 'TEACHER';

-- CreateTable
CREATE TABLE "StudentDevice" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceModel" TEXT,
    "browser" TEXT,
    "browserVersion" TEXT,
    "fingerprint" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "platform" TEXT,
    "userAgent" TEXT,
    "lastIpAddress" TEXT,
    "country" TEXT,
    "city" TEXT,
    "status" "StudentDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "firstLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByTeacherId" TEXT,

    CONSTRAINT "StudentDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentLoginHistory" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "LoginResult" NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "country" TEXT,
    "city" TEXT,

    CONSTRAINT "StudentLoginHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentDevice_deviceId_key" ON "StudentDevice"("deviceId");

-- CreateIndex
CREATE INDEX "StudentDevice_studentId_idx" ON "StudentDevice"("studentId");

-- CreateIndex
CREATE INDEX "StudentDevice_status_idx" ON "StudentDevice"("status");

-- CreateIndex
CREATE INDEX "StudentDevice_deviceId_idx" ON "StudentDevice"("deviceId");

-- CreateIndex
CREATE INDEX "StudentLoginHistory_studentId_idx" ON "StudentLoginHistory"("studentId");

-- CreateIndex
CREATE INDEX "StudentLoginHistory_loggedAt_idx" ON "StudentLoginHistory"("loggedAt");

-- CreateIndex
CREATE INDEX "Student_teacherId_idx" ON "Student"("teacherId");

-- CreateIndex
CREATE INDEX "Student_registrationSource_idx" ON "Student"("registrationSource");

-- CreateIndex
CREATE INDEX "Student_confirmationStatus_idx" ON "Student"("confirmationStatus");

-- CreateIndex
CREATE INDEX "Student_publicClassId_idx" ON "Student"("publicClassId");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_publicClassId_fkey" FOREIGN KEY ("publicClassId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentDevice" ADD CONSTRAINT "StudentDevice_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentDevice" ADD CONSTRAINT "StudentDevice_approvedByTeacherId_fkey" FOREIGN KEY ("approvedByTeacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentLoginHistory" ADD CONSTRAINT "StudentLoginHistory_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentLoginHistory" ADD CONSTRAINT "StudentLoginHistory_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "StudentDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
