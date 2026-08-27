-- CreateEnum
CREATE TYPE "ClassStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Lecture" ADD COLUMN     "classStatus" "ClassStatus" NOT NULL DEFAULT 'SCHEDULED';
