-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "actionTakenDate" TIMESTAMP(3),
ADD COLUMN     "status" INTEGER NOT NULL DEFAULT 0;
