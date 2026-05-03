ALTER TABLE "Student"
ADD COLUMN IF NOT EXISTS "password" TEXT;

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "userId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key"
ON "PasswordResetToken"("tokenHash");

CREATE INDEX IF NOT EXISTS "PasswordResetToken_role_userId_idx"
ON "PasswordResetToken"("role", "userId");

CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx"
ON "PasswordResetToken"("expiresAt");
