-- Add class schedule field
ALTER TABLE "Class"
ADD COLUMN "schedule" TEXT NOT NULL DEFAULT 'TBD';
