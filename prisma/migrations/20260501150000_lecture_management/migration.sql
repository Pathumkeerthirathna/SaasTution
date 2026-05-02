CREATE TYPE "NoteKind" AS ENUM ('NOTE', 'SUPPORTING_MATERIAL');

ALTER TABLE "Note"
ADD COLUMN "kind" "NoteKind" NOT NULL DEFAULT 'NOTE',
ADD COLUMN "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
ADD COLUMN "sizeBytes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_lectureId_fkey"
FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Lecture_classId_date_idx" ON "Lecture"("classId", "date");
CREATE INDEX "Note_lectureId_idx" ON "Note"("lectureId");
CREATE INDEX "Assignment_lectureId_dueDate_idx" ON "Assignment"("lectureId", "dueDate");
CREATE INDEX "Quiz_lectureId_idx" ON "Quiz"("lectureId");
