-- AlterTable
ALTER TABLE "YouTubeRecording" ADD COLUMN     "stopNoticeAcknowledgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "YouTubeLiveBroadcast" ADD COLUMN     "stopNoticeAcknowledgedAt" TIMESTAMP(3);
