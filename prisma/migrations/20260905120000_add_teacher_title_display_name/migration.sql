-- CreateEnum
CREATE TYPE "TeacherTitle" AS ENUM ('MR', 'MRS', 'MS', 'DR', 'PROF');

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "title" "TeacherTitle" NOT NULL DEFAULT 'MR',
ADD COLUMN     "displayName" TEXT;
