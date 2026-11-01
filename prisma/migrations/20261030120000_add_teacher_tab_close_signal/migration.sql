-- AlterEnum
ALTER TYPE "YouTubeFeatureStopReason" ADD VALUE 'YOUTUBE_ENDED';

-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "teacherActiveAfterDepartureAt" TIMESTAMP(3),
ADD COLUMN     "teacherCurrentPageId" TEXT,
ADD COLUMN     "teacherDepartureAt" TIMESTAMP(3),
ADD COLUMN     "teacherDeparturePageId" TEXT;
