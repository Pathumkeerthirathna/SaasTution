-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "jibriStopOverrideAt" TIMESTAMP(3),
ADD COLUMN     "jibriStopOverrideBy" TEXT,
ADD COLUMN     "jibriStopOverrideReason" TEXT,
ADD COLUMN     "jibriStopRecorderLeftAt" TIMESTAMP(3),
ADD COLUMN     "jibriStopStreamInactiveAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "JibriShutdownOverride" (
    "id" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "fenceDepartureAt" TIMESTAMP(3) NOT NULL,
    "previousState" TEXT,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JibriShutdownOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JibriShutdownOverride_classSessionId_createdAt_idx" ON "JibriShutdownOverride"("classSessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "JibriShutdownOverride" ADD CONSTRAINT "JibriShutdownOverride_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
