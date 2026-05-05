/*
  Warnings:

  - Added the required column `fileName` to the `AssignmentSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fileUrl` to the `AssignmentSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mimeType` to the `AssignmentSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sizeBytes` to the `AssignmentSubmission` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AssignmentSubmission" ADD COLUMN     "fileName" TEXT NOT NULL,
ADD COLUMN     "fileUrl" TEXT NOT NULL,
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "sizeBytes" INTEGER NOT NULL;
