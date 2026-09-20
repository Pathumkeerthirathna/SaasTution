-- CreateTable
CREATE TABLE "LectureWhiteboard" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LectureWhiteboard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LectureWhiteboard_lectureId_status_createdAt_idx" ON "LectureWhiteboard"("lectureId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "LectureWhiteboard" ADD CONSTRAINT "LectureWhiteboard_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
