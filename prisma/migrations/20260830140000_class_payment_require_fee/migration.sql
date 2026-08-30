-- DropForeignKey
ALTER TABLE "ClassPayment" DROP CONSTRAINT "ClassPayment_classStudentFeeId_fkey";

-- DropIndex
DROP INDEX "ClassPayment_classId_studentId_month_key";

-- DropIndex
DROP INDEX "ClassPayment_studentId_month_idx";

-- DropIndex
DROP INDEX "ClassPayment_classId_month_status_idx";

-- AlterTable
ALTER TABLE "ClassPayment" DROP COLUMN "month";

-- AlterTable
ALTER TABLE "ClassPayment" ALTER COLUMN "classStudentFeeId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "ClassPayment_studentId_idx" ON "ClassPayment"("studentId");

-- CreateIndex
CREATE INDEX "ClassPayment_classId_status_idx" ON "ClassPayment"("classId", "status");

-- CreateIndex
CREATE INDEX "ClassPayment_confirmedByTeacherId_idx" ON "ClassPayment"("confirmedByTeacherId");

-- AddForeignKey
ALTER TABLE "ClassPayment" ADD CONSTRAINT "ClassPayment_classStudentFeeId_fkey" FOREIGN KEY ("classStudentFeeId") REFERENCES "ClassStudentFee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
