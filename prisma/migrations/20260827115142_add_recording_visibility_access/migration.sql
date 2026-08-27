-- CreateEnum
CREATE TYPE "RecordingVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "RecordingAccess" AS ENUM ('FREE', 'LOCKED');

-- AlterTable
ALTER TABLE "YouTubeRecording" ADD COLUMN     "access" "RecordingAccess" NOT NULL DEFAULT 'LOCKED',
ADD COLUMN     "visibility" "RecordingVisibility" NOT NULL DEFAULT 'PRIVATE';
