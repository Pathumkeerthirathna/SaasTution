-- AlterTable
ALTER TABLE "YouTubeRecording" ADD COLUMN     "autoStopCheckedAt" TIMESTAMP(3),
ADD COLUMN     "autoStopLastError" TEXT,
ADD COLUMN     "autoStopSendCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "generationStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "YouTubeLiveBroadcast" ADD COLUMN     "autoStopCheckedAt" TIMESTAMP(3),
ADD COLUMN     "autoStopLastError" TEXT,
ADD COLUMN     "autoStopSendCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "generationStartedAt" TIMESTAMP(3);
