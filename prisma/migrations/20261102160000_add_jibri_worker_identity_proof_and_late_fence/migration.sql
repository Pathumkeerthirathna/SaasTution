-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "jibriStopOrigin" TEXT;

-- AlterTable
ALTER TABLE "JibriShutdownControl" ADD COLUMN     "lastConnectionError" TEXT,
ADD COLUMN     "lastConnectionErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastRoomJoinAt" TIMESTAMP(3),
ADD COLUMN     "lastXmppAuthAt" TIMESTAMP(3),
ADD COLUMN     "sweepCompletedAt" TIMESTAMP(3),
ADD COLUMN     "sweepStartedAt" TIMESTAMP(3),
ADD COLUMN     "workerFocusJid" TEXT,
ADD COLUMN     "workerJitsiDomain" TEXT,
ADD COLUMN     "workerJwtAudience" TEXT,
ADD COLUMN     "workerJwtFingerprint" TEXT,
ADD COLUMN     "workerJwtIssuer" TEXT,
ADD COLUMN     "workerMucDomain" TEXT,
ADD COLUMN     "workerRecorderDomain" TEXT,
ADD COLUMN     "workerWebsocketUrl" TEXT;

-- CreateIndex
CREATE INDEX "ClassSession_isActive_endedAt_idx" ON "ClassSession"("isActive", "endedAt");

