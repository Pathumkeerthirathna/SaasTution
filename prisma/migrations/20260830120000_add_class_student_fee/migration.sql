-- CreateTable
CREATE TABLE "ClassStudentFee" (
    "id" TEXT NOT NULL,
    "classStudentId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "lateJoinDeduct" INTEGER NOT NULL DEFAULT 0,
    "waiverAmount" INTEGER NOT NULL DEFAULT 0,
    "finalAmount" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassStudentFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassStudentFee_classStudentId_year_month_idx" ON "ClassStudentFee"("classStudentId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ClassStudentFee_classStudentId_year_month_key" ON "ClassStudentFee"("classStudentId", "year", "month");

-- AlterTable
ALTER TABLE "ClassPayment" ADD COLUMN "classStudentFeeId" TEXT;

-- CreateIndex
CREATE INDEX "ClassPayment_classStudentFeeId_idx" ON "ClassPayment"("classStudentFeeId");

-- AddForeignKey
ALTER TABLE "ClassStudentFee" ADD CONSTRAINT "ClassStudentFee_classStudentId_fkey" FOREIGN KEY ("classStudentId") REFERENCES "ClassStudent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPayment" ADD CONSTRAINT "ClassPayment_classStudentFeeId_fkey" FOREIGN KEY ("classStudentFeeId") REFERENCES "ClassStudentFee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
