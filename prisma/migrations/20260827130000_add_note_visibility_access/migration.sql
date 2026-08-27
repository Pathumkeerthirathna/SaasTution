-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "access" "RecordingAccess" NOT NULL DEFAULT 'LOCKED',
ADD COLUMN     "visibility" "RecordingVisibility" NOT NULL DEFAULT 'PRIVATE';
