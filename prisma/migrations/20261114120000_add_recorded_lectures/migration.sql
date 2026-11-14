-- ---------------------------------------------------------------------------
-- Recorded Lectures: database foundation (RL-2).
--
-- Two enums and three new tables ("RecordedLecture", "RecordingUploadSession",
-- "RecordingUploadChunk"), their indexes and foreign keys, plus one additive
-- unique index on "Class" ("id", "teacherId"): the target of the composite
-- foreign key that ties a recording's teacher to the teacher who owns its
-- class. "Class"."id" is already the primary key, so that index cannot fail
-- on existing rows. No existing column, row, constraint, index or migration
-- is changed or dropped. Nothing is backfilled.
--
-- Ownership integrity:
--   "RecordedLecture" ("lectureId", "classId") -> "Lecture" ("id", "classId")
--   "RecordedLecture" ("classId", "teacherId") -> "Class" ("id", "teacherId")
--   "RecordingUploadSession" ("recordedLectureId", "teacherId")
--                                     -> "RecordedLecture" ("id", "teacherId")
-- Storage keys contain the recording, lecture and teacher ids, so every new
-- foreign key is ON UPDATE RESTRICT (no code changes those ids, a class's
-- teacher or a lecture's class). Lecture -> recording -> session -> chunk is
-- ON DELETE CASCADE (lectures are only soft-deleted today); teacher and
-- class references are ON DELETE RESTRICT.
--
-- Timestamps have no database default: the application writes real UTC
-- instants. Sizes and offsets are BIGINT (up to 64,000,000,000 bytes, the
-- highest allowed RECORDED_LECTURE_MAX_PART_BYTES). The CHECK limits are the
-- highest values the configuration allows, never the current defaults.
--
-- Parts marked MANUAL are hand-written (CHECK constraints and one partial
-- unique index): Prisma 5.22 cannot express them. `prisma migrate dev` may
-- report the partial index as drift and offer to drop it: never accept.
-- Apply with `prisma migrate deploy` over the direct (non-pooled)
-- connection only, never `prisma db push`. Guarded by
-- tests/recorded-lectures/recorded-lectures-migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- MANUAL: fail instead of waiting indefinitely for a lock (the "Class" unique
-- index and the foreign keys to "Lecture", "Class" and "Teacher" lock those
-- tables briefly). Each single lock wait is limited to 5 seconds. Session
-- level SET, RESET at the end (as in 20261110140000_add_lecture_attendance).
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "RecordedLectureState" AS ENUM ('UPLOADING', 'VERIFYING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RecordingUploadState" AS ENUM ('ACTIVE', 'COMPLETING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RecordedLecture" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "displayFileName" VARCHAR(200) NOT NULL,
    "mimeType" VARCHAR(32) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "storedFileName" VARCHAR(36),
    "durationSeconds" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" VARCHAR(32),
    "audioCodec" VARCHAR(32),
    "fragmented" BOOLEAN,
    "state" "RecordedLectureState" NOT NULL,
    "failureCode" VARCHAR(64),
    "status" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "deletedByTeacherId" TEXT,
    "purgeRequestedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "RecordedLecture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingUploadSession" (
    "id" TEXT NOT NULL,
    "recordedLectureId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "expectedBytes" BIGINT NOT NULL,
    "receivedBytes" BIGINT NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "state" "RecordingUploadState" NOT NULL,
    "failureCode" VARCHAR(64),
    "leaseToken" CHAR(64),
    "leaseOffset" BIGINT,
    "leaseBytes" INTEGER,
    "leaseGrantedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecordingUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingUploadChunk" (
    "id" TEXT NOT NULL,
    "uploadSessionId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "startOffset" BIGINT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "leaseToken" CHAR(64) NOT NULL,
    "sha256" CHAR(64),
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingUploadChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordedLecture_lectureId_status_state_partNumber_idx" ON "RecordedLecture"("lectureId", "status", "state", "partNumber");

-- CreateIndex
CREATE INDEX "RecordedLecture_teacherId_createdAt_idx" ON "RecordedLecture"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "RecordedLecture_classId_idx" ON "RecordedLecture"("classId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordedLecture_id_teacherId_key" ON "RecordedLecture"("id", "teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingUploadSession_leaseToken_key" ON "RecordingUploadSession"("leaseToken");

-- CreateIndex
CREATE INDEX "RecordingUploadSession_teacherId_state_idx" ON "RecordingUploadSession"("teacherId", "state");

-- CreateIndex
CREATE INDEX "RecordingUploadSession_state_expiresAt_idx" ON "RecordingUploadSession"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "RecordingUploadSession_state_idx" ON "RecordingUploadSession"("state");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingUploadSession_recordedLectureId_teacherId_key" ON "RecordingUploadSession"("recordedLectureId", "teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingUploadChunk_leaseToken_key" ON "RecordingUploadChunk"("leaseToken");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingUploadChunk_uploadSessionId_chunkIndex_key" ON "RecordingUploadChunk"("uploadSessionId", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingUploadChunk_uploadSessionId_startOffset_key" ON "RecordingUploadChunk"("uploadSessionId", "startOffset");

-- CreateIndex
CREATE UNIQUE INDEX "Class_id_teacherId_key" ON "Class"("id", "teacherId");

-- AddForeignKey
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "Lecture"("id", "classId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_classId_teacherId_fkey" FOREIGN KEY ("classId", "teacherId") REFERENCES "Class"("id", "teacherId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_deletedByTeacherId_fkey" FOREIGN KEY ("deletedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_recordedLectureId_teacherId_fkey" FOREIGN KEY ("recordedLectureId", "teacherId") REFERENCES "RecordedLecture"("id", "teacherId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_uploadSessionId_fkey" FOREIGN KEY ("uploadSessionId") REFERENCES "RecordingUploadSession"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- MANUAL: one active part number per lecture. Purge pending (status 2),
-- removed (status 1) and FAILED parts free their number for a new upload.
CREATE UNIQUE INDEX "RecordedLecture_active_part_number_key"
  ON "RecordedLecture" ("lectureId", "partNumber")
  WHERE "status" = 0 AND "state" <> 'FAILED';

-- MANUAL: RecordedLecture CHECK constraints.
-- (A CHECK whose expression is NULL passes, so nullable columns are tested
-- with an explicit IS NULL / IS NOT NULL.)

-- The ids that become storage key segments are lowercase UUIDs
-- (lib/recorded-lectures/keys.ts).
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_key_ids_format_check"
  CHECK (
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "lectureId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "teacherId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_title_check"
  CHECK (btrim("title") <> '');
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_partNumber_check"
  CHECK ("partNumber" >= 1);
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_displayFileName_check"
  CHECK (char_length("displayFileName") >= 5 AND right("displayFileName", 4) = '.mp4');
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_mimeType_check"
  CHECK ("mimeType" = 'video/mp4');
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_sizeBytes_check"
  CHECK ("sizeBytes" BETWEEN 1 AND 64000000000);
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_storedFileName_check"
  CHECK ("storedFileName" IS NULL OR "storedFileName" ~ '^[0-9a-f]{32}\.mp4$');
-- At most 48 hours. An invalid or longer duration fails the upload (RL-3).
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_durationSeconds_check"
  CHECK ("durationSeconds" IS NULL OR "durationSeconds" BETWEEN 1 AND 172800);
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_width_check"
  CHECK ("width" IS NULL OR "width" BETWEEN 1 AND 65535);
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_height_check"
  CHECK ("height" IS NULL OR "height" BETWEEN 1 AND 65535);
-- H.264 (lib/recorded-lectures/mp4-inspect.ts): "avc1." / "avc3." + profile,
-- compatibility and level as upper-case hex.
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_videoCodec_check"
  CHECK ("videoCodec" IS NULL OR "videoCodec" ~ '^avc[13]\.[0-9A-F]{6}$');
-- AAC-LC, HE-AAC, HE-AAC v2.
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_audioCodec_check"
  CHECK ("audioCodec" IS NULL OR "audioCodec" IN ('mp4a.40.2', 'mp4a.40.5', 'mp4a.40.29'));
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_failureCode_check"
  CHECK (
    ("state" = 'FAILED') = ("failureCode" IS NOT NULL)
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  );
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_readyAt_check"
  CHECK (("state" = 'READY') = ("readyAt" IS NOT NULL));
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_failedAt_check"
  CHECK (("state" = 'FAILED') = ("failedAt" IS NOT NULL));
-- A READY part has its final file and its verified metadata.
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_ready_metadata_check"
  CHECK (
    "state" <> 'READY'
    OR (
      "storedFileName" IS NOT NULL
      AND "durationSeconds" IS NOT NULL
      AND "videoCodec" IS NOT NULL
      AND "audioCodec" IS NOT NULL
      AND "fragmented" IS NOT NULL
    )
  );
-- 0 = active; 2 = purge pending (deletion requested, the stored file's
-- deletion pending or failed, retryable); 1 = removed (the stored file's
-- deletion completed; final, not recoverable). Lifecycle:
--   status 0: "deletedAt", "purgeRequestedAt", "purgedAt" all NULL;
--   deletion requested: status 2, "deletedAt" and "purgeRequestedAt" set,
--     "purgedAt" NULL (no playback from then on);
--   file deletion succeeded: status 1, "purgeRequestedAt" cleared,
--     "purgedAt" set ("deletedAt" kept);
--   file deletion failed: stays status 2 (retried).
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_status_check"
  CHECK ("status" IN (0, 1, 2));
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_deletedAt_check"
  CHECK (("status" = 0) = ("deletedAt" IS NULL));
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_deletedBy_check"
  CHECK ("deletedByTeacherId" IS NULL OR "deletedAt" IS NOT NULL);
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_purgeRequestedAt_check"
  CHECK (("status" = 2) = ("purgeRequestedAt" IS NOT NULL));
-- The physical file deletion completed exactly for status 1 (NULL while
-- active or purge pending).
ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_purgedAt_check"
  CHECK (("status" = 1) = ("purgedAt" IS NOT NULL));

-- MANUAL: RecordingUploadSession CHECK constraints.

-- The id names the temporary files (System/TemporaryUploads/{id}.part).
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_id_format_check"
  CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_expectedBytes_check"
  CHECK ("expectedBytes" BETWEEN 1 AND 64000000000);
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_receivedBytes_check"
  CHECK ("receivedBytes" >= 0 AND "receivedBytes" <= "expectedBytes");
-- Every committed chunk holds at least one byte.
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_chunkCount_check"
  CHECK (
    "chunkCount" >= 0
    AND "chunkCount" <= "receivedBytes"
    AND ("chunkCount" = 0) = ("receivedBytes" = 0)
  );
-- The five lease columns are all NULL (no lease) or all set.
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_lease_all_or_none_check"
  CHECK (
    (
      "leaseToken" IS NULL AND "leaseOffset" IS NULL AND "leaseBytes" IS NULL
      AND "leaseGrantedAt" IS NULL AND "leaseExpiresAt" IS NULL
    )
    OR (
      "leaseToken" IS NOT NULL AND "leaseOffset" IS NOT NULL AND "leaseBytes" IS NOT NULL
      AND "leaseGrantedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL
    )
  );
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_leaseToken_check"
  CHECK ("leaseToken" IS NULL OR "leaseToken" ~ '^[0-9a-f]{64}$');
-- A lease always starts at the bytes already received.
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_leaseOffset_check"
  CHECK ("leaseOffset" IS NULL OR "leaseOffset" = "receivedBytes");
-- Positive, at most one maximum chunk (64 MiB), at most the bytes remaining.
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_leaseBytes_check"
  CHECK (
    "leaseBytes" IS NULL
    OR ("leaseBytes" BETWEEN 1 AND 67108864 AND "leaseBytes" <= "expectedBytes" - "receivedBytes")
  );
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_leaseExpiresAt_check"
  CHECK ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" > "leaseGrantedAt");
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_lease_only_active_check"
  CHECK ("leaseToken" IS NULL OR "state" = 'ACTIVE');
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_complete_bytes_check"
  CHECK ("state" NOT IN ('COMPLETING', 'COMPLETED') OR "receivedBytes" = "expectedBytes");
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_endedAt_check"
  CHECK (("state" IN ('COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')) = ("endedAt" IS NOT NULL));
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_failureCode_check"
  CHECK (
    ("state" = 'FAILED') = ("failureCode" IS NOT NULL)
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  );
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_expiresAt_check"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_version_check"
  CHECK ("version" >= 0);

-- MANUAL: RecordingUploadChunk CHECK constraints.
ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_position_check"
  CHECK (
    "chunkIndex" >= 0
    AND "startOffset" >= 0
    AND ("chunkIndex" = 0) = ("startOffset" = 0)
  );
ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_byteLength_check"
  CHECK ("byteLength" BETWEEN 1 AND 67108864);
ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_end_check"
  CHECK ("startOffset" + "byteLength" <= 64000000000);
ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_leaseToken_check"
  CHECK ("leaseToken" ~ '^[0-9a-f]{64}$');
ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_sha256_check"
  CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');

-- MANUAL: restore the default lock timeout for the rest of the session.
RESET lock_timeout;
