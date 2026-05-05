-- Add class fee and monthly payment workflow
ALTER TABLE "Class"
ADD COLUMN "monthlyFee" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "ClassPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'NEEDS_CLARIFICATION');
CREATE TYPE "PaymentMessageSender" AS ENUM ('STUDENT', 'TEACHER');

CREATE TABLE "ClassPayment" (
  "id" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "note" TEXT,
  "slipFileName" TEXT,
  "slipFileUrl" TEXT,
  "slipMimeType" TEXT,
  "slipSizeBytes" INTEGER,
  "status" "ClassPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "teacherFeedback" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "confirmedByTeacherId" TEXT,

  CONSTRAINT "ClassPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentMessage" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "senderRole" "PaymentMessageSender" NOT NULL,
  "studentId" TEXT,
  "teacherId" TEXT,
  "message" TEXT NOT NULL,
  "proofFileName" TEXT,
  "proofFileUrl" TEXT,
  "proofMimeType" TEXT,
  "proofSizeBytes" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassPayment_classId_studentId_month_key" ON "ClassPayment"("classId", "studentId", "month");
CREATE INDEX "ClassPayment_studentId_month_idx" ON "ClassPayment"("studentId", "month");
CREATE INDEX "ClassPayment_classId_month_status_idx" ON "ClassPayment"("classId", "month", "status");
CREATE INDEX "PaymentMessage_paymentId_createdAt_idx" ON "PaymentMessage"("paymentId", "createdAt");

ALTER TABLE "ClassPayment"
ADD CONSTRAINT "ClassPayment_classId_fkey"
FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassPayment"
ADD CONSTRAINT "ClassPayment_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassPayment"
ADD CONSTRAINT "ClassPayment_confirmedByTeacherId_fkey"
FOREIGN KEY ("confirmedByTeacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentMessage"
ADD CONSTRAINT "PaymentMessage_paymentId_fkey"
FOREIGN KEY ("paymentId") REFERENCES "ClassPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentMessage"
ADD CONSTRAINT "PaymentMessage_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentMessage"
ADD CONSTRAINT "PaymentMessage_teacherId_fkey"
FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
