/*
  Warnings:

  - You are about to drop the column `grade` on the `Student` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Student_registrationNumber_key";

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "grade",
ADD COLUMN     "gradeId" INTEGER DEFAULT 6;

-- DropEnum
DROP TYPE "GradeLevel";

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
