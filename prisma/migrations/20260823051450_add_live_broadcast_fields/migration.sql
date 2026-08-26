-- AlterTable
ALTER TABLE "Lecture" ADD COLUMN     "youtubeLiveBroadcastId" TEXT,
ADD COLUMN     "youtubeLivePrivacy" "YouTubePrivacy",
ADD COLUMN     "youtubeLiveStatus" "YouTubeBroadcastStatus",
ADD COLUMN     "youtubeLiveUrl" TEXT,
ADD COLUMN     "youtubeLiveVideoId" TEXT;
