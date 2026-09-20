-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "emailConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "emailConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailConfirmedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailVerificationCode_role_userId_idx" ON "EmailVerificationCode"("role", "userId");

-- CreateIndex
CREATE INDEX "EmailVerificationCode_expiresAt_idx" ON "EmailVerificationCode"("expiresAt");

-- Backfill: accounts that already existed before this migration were never
-- put through an email-confirmation step, so grandfather them in as
-- confirmed rather than locking every existing teacher and student out of
-- the app. Only new accounts created from here on must confirm their email.
UPDATE "Teacher" SET "emailConfirmed" = true, "emailConfirmedAt" = "createdAt" WHERE "emailConfirmed" = false;
UPDATE "Student" SET "emailConfirmed" = true, "emailConfirmedAt" = "createdAt" WHERE "emailConfirmed" = false AND "email" IS NOT NULL AND "email" <> '';
