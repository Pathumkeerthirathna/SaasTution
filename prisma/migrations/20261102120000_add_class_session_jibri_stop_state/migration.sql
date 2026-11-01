-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "jibriStopAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "jibriStopAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "jibriStopConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "jibriStopDepartureAt" TIMESTAMP(3),
ADD COLUMN     "jibriStopLastError" TEXT,
ADD COLUMN     "jibriStopState" TEXT;
