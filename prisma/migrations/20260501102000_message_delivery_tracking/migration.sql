CREATE TYPE "MessageDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageDelivery_messageId_studentId_key" ON "MessageDelivery"("messageId", "studentId");
CREATE INDEX "MessageDelivery_providerMessageId_idx" ON "MessageDelivery"("providerMessageId");

ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
