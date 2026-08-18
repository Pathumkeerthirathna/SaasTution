-- CreateTable
CREATE TABLE "YouTubeConnection" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelTitle" TEXT,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "liveStreamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeConnection_teacherId_key" ON "YouTubeConnection"("teacherId");

-- CreateIndex
CREATE INDEX "YouTubeConnection_channelId_idx" ON "YouTubeConnection"("channelId");

-- AddForeignKey
ALTER TABLE "YouTubeConnection" ADD CONSTRAINT "YouTubeConnection_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
