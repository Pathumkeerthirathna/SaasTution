-- CreateEnum
CREATE TYPE "YouTubeConnectionStatus" AS ENUM ('CONNECTED', 'REAUTH_REQUIRED');

-- AlterTable
ALTER TABLE "YouTubeConnection" ADD COLUMN     "status" "YouTubeConnectionStatus" NOT NULL DEFAULT 'CONNECTED';
