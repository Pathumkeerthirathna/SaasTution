/*
  Warnings:

  - You are about to drop the column `youtubeBroadcastId` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeLiveBroadcastId` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeLivePrivacy` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeLiveStatus` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeLiveUrl` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeLiveVideoId` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubePrivacy` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeStatus` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeUrl` on the `Lecture` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeVideoId` on the `Lecture` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Lecture" DROP COLUMN "youtubeBroadcastId",
DROP COLUMN "youtubeLiveBroadcastId",
DROP COLUMN "youtubeLivePrivacy",
DROP COLUMN "youtubeLiveStatus",
DROP COLUMN "youtubeLiveUrl",
DROP COLUMN "youtubeLiveVideoId",
DROP COLUMN "youtubePrivacy",
DROP COLUMN "youtubeStatus",
DROP COLUMN "youtubeUrl",
DROP COLUMN "youtubeVideoId";

-- CreateTable
CREATE TABLE "YouTubeRecording" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "youtubeUrl" TEXT NOT NULL,
    "privacy" "YouTubePrivacy" NOT NULL DEFAULT 'UNLISTED',
    "status" "YouTubeBroadcastStatus" NOT NULL DEFAULT 'READY',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeLiveBroadcast" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "youtubeUrl" TEXT NOT NULL,
    "privacy" "YouTubePrivacy" NOT NULL DEFAULT 'UNLISTED',
    "status" "YouTubeBroadcastStatus" NOT NULL DEFAULT 'READY',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeLiveBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeRecording_broadcastId_key" ON "YouTubeRecording"("broadcastId");

-- CreateIndex
CREATE INDEX "YouTubeRecording_lectureId_idx" ON "YouTubeRecording"("lectureId");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeLiveBroadcast_broadcastId_key" ON "YouTubeLiveBroadcast"("broadcastId");

-- CreateIndex
CREATE INDEX "YouTubeLiveBroadcast_lectureId_idx" ON "YouTubeLiveBroadcast"("lectureId");

-- AddForeignKey
ALTER TABLE "YouTubeRecording" ADD CONSTRAINT "YouTubeRecording_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeLiveBroadcast" ADD CONSTRAINT "YouTubeLiveBroadcast_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
