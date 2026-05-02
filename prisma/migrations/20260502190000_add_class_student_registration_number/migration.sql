ALTER TABLE "ClassStudent"
ADD COLUMN "registrationNumber" TEXT;

CREATE UNIQUE INDEX "ClassStudent_registrationNumber_key"
ON "ClassStudent"("registrationNumber");
