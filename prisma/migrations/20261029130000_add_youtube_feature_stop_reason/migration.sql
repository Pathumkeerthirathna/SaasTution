-- CreateEnum
CREATE TYPE "YouTubeFeatureStopReason" AS ENUM ('TEACHER_LEFT');

-- AlterTable
ALTER TABLE "YouTubeRecording" ADD COLUMN     "autoStopAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "autoStopError" TEXT,
ADD COLUMN     "stopReason" "YouTubeFeatureStopReason";

-- AlterTable
ALTER TABLE "YouTubeLiveBroadcast" ADD COLUMN     "autoStopAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "autoStopError" TEXT,
ADD COLUMN     "stopReason" "YouTubeFeatureStopReason";
