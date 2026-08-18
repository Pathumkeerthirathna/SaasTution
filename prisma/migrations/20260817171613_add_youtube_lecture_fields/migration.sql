-- CreateEnum
CREATE TYPE "YouTubePrivacy" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "YouTubeBroadcastStatus" AS ENUM ('CREATED', 'READY', 'TESTING', 'LIVE', 'COMPLETE', 'REVOKED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Lecture" ADD COLUMN     "youtubeBroadcastId" TEXT,
ADD COLUMN     "youtubePrivacy" "YouTubePrivacy",
ADD COLUMN     "youtubeStatus" "YouTubeBroadcastStatus",
ADD COLUMN     "youtubeUrl" TEXT,
ADD COLUMN     "youtubeVideoId" TEXT;
