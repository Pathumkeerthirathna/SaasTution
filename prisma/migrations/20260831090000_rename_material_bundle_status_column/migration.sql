-- Rename MaterialBundle.status -> MaterialBundle.bundleStatus (preserves data)
ALTER TABLE "MaterialBundle" RENAME COLUMN "status" TO "bundleStatus";

-- Recreate the index under the new column name
DROP INDEX "MaterialBundle_status_sentAt_idx";
CREATE INDEX "MaterialBundle_bundleStatus_sentAt_idx" ON "MaterialBundle"("bundleStatus", "sentAt");
