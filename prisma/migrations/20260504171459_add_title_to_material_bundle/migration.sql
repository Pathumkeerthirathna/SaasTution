/*
  Warnings:

  - Added the required column `title` to the `MaterialBundle` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "MaterialBundle" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MaterialBundle" ALTER COLUMN "title" DROP DEFAULT;
