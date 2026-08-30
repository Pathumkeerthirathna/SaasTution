-- CreateTable
CREATE TABLE "ClassFee" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassFee_classId_effectiveFrom_idx" ON "ClassFee"("classId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "ClassFee" ADD CONSTRAINT "ClassFee_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing class gets an open fee period covering its current
-- monthly fee, effective from when the class was created (shifted to Sri Lanka
-- wall-clock time so it matches how new rows are written).
INSERT INTO "ClassFee" ("id", "classId", "amount", "effectiveFrom", "effectiveTo", "createdAt")
SELECT
    gen_random_uuid(),
    "id",
    "monthlyFee",
    "createdAt" + INTERVAL '5 hours 30 minutes',
    NULL,
    CURRENT_TIMESTAMP + INTERVAL '5 hours 30 minutes'
FROM "Class";
