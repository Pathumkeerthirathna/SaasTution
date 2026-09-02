-- CreateTable
CREATE TABLE "NoteStudent" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "viewed" BOOLEAN NOT NULL DEFAULT false,
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteStudent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NoteStudent_studentId_idx" ON "NoteStudent"("studentId");

-- CreateIndex
CREATE INDEX "NoteStudent_noteId_idx" ON "NoteStudent"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "NoteStudent_noteId_studentId_key" ON "NoteStudent"("noteId", "studentId");

-- AddForeignKey
ALTER TABLE "NoteStudent" ADD CONSTRAINT "NoteStudent_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteStudent" ADD CONSTRAINT "NoteStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one NoteStudent per active note x each active student of the note's class.
INSERT INTO "NoteStudent" ("id", "noteId", "studentId", "viewed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), n."id", cs."studentId", false, now(), now()
FROM "Note" n
JOIN "Lecture" l ON l."id" = n."lectureId"
JOIN "ClassStudent" cs ON cs."classId" = l."classId" AND cs."isActive" = true
JOIN "Student" s ON s."id" = cs."studentId" AND s."status" = 0
WHERE n."status" = 0
ON CONFLICT ("noteId", "studentId") DO NOTHING;
