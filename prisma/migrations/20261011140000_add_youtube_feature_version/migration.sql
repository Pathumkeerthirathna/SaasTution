-- AlterTable
ALTER TABLE "YouTubeRecording" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "YouTubeLiveBroadcast" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;
