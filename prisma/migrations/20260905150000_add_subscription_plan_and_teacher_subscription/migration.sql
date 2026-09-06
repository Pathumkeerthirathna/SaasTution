-- CreateEnum
CREATE TYPE "SubscriptionPlanStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SubscriptionInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "interval" "SubscriptionInterval" NOT NULL DEFAULT 'MONTHLY',
    "maxLiveParticipants" INTEGER NOT NULL,
    "unlimitedLiveSessions" BOOLEAN NOT NULL DEFAULT true,
    "unlimitedRecording" BOOLEAN NOT NULL DEFAULT true,
    "unlimitedStudents" BOOLEAN NOT NULL DEFAULT true,
    "maxTeachers" INTEGER,
    "storageGB" INTEGER,
    "status" "SubscriptionPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherSubscription" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_name_key" ON "SubscriptionPlan"("name");

-- CreateIndex
CREATE INDEX "SubscriptionPlan_status_idx" ON "SubscriptionPlan"("status");

-- CreateIndex
CREATE INDEX "TeacherSubscription_teacherId_idx" ON "TeacherSubscription"("teacherId");

-- CreateIndex
CREATE INDEX "TeacherSubscription_planId_idx" ON "TeacherSubscription"("planId");

-- CreateIndex
CREATE INDEX "TeacherSubscription_status_idx" ON "TeacherSubscription"("status");

-- AddForeignKey
ALTER TABLE "TeacherSubscription" ADD CONSTRAINT "TeacherSubscription_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSubscription" ADD CONSTRAINT "TeacherSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
