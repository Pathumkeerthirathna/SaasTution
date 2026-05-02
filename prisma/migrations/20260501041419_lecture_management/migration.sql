-- Legacy migration made shadow-db-safe:
-- These columns may not exist at this point in migration order, so guard the operation.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'Note'
			AND column_name = 'mimeType'
	) AND EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'Note'
			AND column_name = 'sizeBytes'
	) THEN
		ALTER TABLE "Note"
			ALTER COLUMN "mimeType" DROP DEFAULT,
			ALTER COLUMN "sizeBytes" DROP DEFAULT;
	END IF;
END $$;
