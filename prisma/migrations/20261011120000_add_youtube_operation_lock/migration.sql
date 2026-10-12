-- CreateTable
CREATE TABLE "YouTubeOperationLock" (
    "lectureId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YouTubeOperationLock_pkey" PRIMARY KEY ("lectureId")
);

