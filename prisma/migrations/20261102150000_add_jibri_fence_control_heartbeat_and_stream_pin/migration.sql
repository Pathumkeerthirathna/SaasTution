-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "jibriStopIdleReadingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "jibriStopLastIdleAt" TIMESTAMP(3),
ADD COLUMN     "jibriStopStreamId" TEXT,
ADD COLUMN     "jibriStopWatchUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "JibriShutdownControl" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "modeChangedAt" TIMESTAMP(3),
    "modeChangedBy" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "workerStartedAt" TIMESTAMP(3),
    "workerVersion" TEXT,
    "workerConfigId" TEXT,
    "workerMode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JibriShutdownControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JibriShutdownModeChange" (
    "id" TEXT NOT NULL,
    "fromMode" TEXT NOT NULL,
    "toMode" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JibriShutdownModeChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JibriShutdownModeChange_createdAt_idx" ON "JibriShutdownModeChange"("createdAt");

-- CreateIndex
CREATE INDEX "ClassSession_classId_jibriStopState_idx" ON "ClassSession"("classId", "jibriStopState");
