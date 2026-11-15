-- ---------------------------------------------------------------------------
-- Teacher profile images on unified storage (2 of 2): the photo's storage key
-- and metadata on "TeacherProfile", and PROFILE_IMAGE reservation keys.
--
-- Additive only: four NULLABLE columns, one unique index, CHECK constraints,
-- and the "StorageReservation" key-format CHECK replaced by one that also
-- accepts profile-photo keys (the NOTE / SUBMISSION patterns are unchanged).
-- "profileImageUrl" stays the display URL and is not changed. No row, file or
-- legacy photo is moved, rewritten or deleted; nothing is backfilled: existing
-- profiles get NULL in all four columns and keep their legacy URL.
--
-- Parts marked MANUAL are hand-written; the rest is exactly what
-- `prisma migrate diff` generates for the schema change. Guarded by
-- tests/storage-quota/profile-image-migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- MANUAL: give up after 5 s instead of queueing behind a long transaction
-- (ALTER TABLE takes an exclusive lock); the migration can then be re-run.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "profileImageMimeType" VARCHAR(32),
ADD COLUMN     "profileImageSha256" CHAR(64),
ADD COLUMN     "profileImageSizeBytes" INTEGER,
ADD COLUMN     "profileImageStorageKey" VARCHAR(512);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_profileImageStorageKey_key" ON "TeacherProfile"("profileImageStorageKey");

-- MANUAL: CHECK constraints. (A CHECK whose expression is NULL passes, so the
-- all-or-none rule is written with explicit IS NULL tests.)
--   *_all_or_none:        key, digest, size and type are set and cleared together.
--   *_storageKey_format:  lib/profile-images/storage-keys.ts exactly (relative,
--                         no "..", server-generated 32-hex name, jpg / png / webp).
--   *_storageKey_owner:   the key lies below THIS teacher's Teachers/{teacherId}/.
--   *_extension_matches:  the key's extension matches the stored type.
ALTER TABLE "TeacherProfile"
  ADD CONSTRAINT "TeacherProfile_profileImage_all_or_none"
    CHECK (
      ("profileImageStorageKey" IS NULL) = ("profileImageSha256" IS NULL)
      AND ("profileImageStorageKey" IS NULL) = ("profileImageSizeBytes" IS NULL)
      AND ("profileImageStorageKey" IS NULL) = ("profileImageMimeType" IS NULL)
    ),
  ADD CONSTRAINT "TeacherProfile_profileImageStorageKey_format"
    CHECK ("profileImageStorageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Profile/Photo/[0-9a-f]{32}\.(jpg|png|webp)$'),
  ADD CONSTRAINT "TeacherProfile_profileImageStorageKey_owner"
    CHECK (left("profileImageStorageKey", length('Teachers/' || "teacherId" || '/')) = 'Teachers/' || "teacherId" || '/'),
  ADD CONSTRAINT "TeacherProfile_profileImageSha256_format"
    CHECK ("profileImageSha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "TeacherProfile_profileImageSizeBytes_range"
    CHECK ("profileImageSizeBytes" BETWEEN 1 AND 2097152),
  ADD CONSTRAINT "TeacherProfile_profileImageMimeType_allowed"
    CHECK ("profileImageMimeType" IN ('image/jpeg', 'image/png', 'image/webp')),
  ADD CONSTRAINT "TeacherProfile_profileImage_extension_matches"
    CHECK (
      "profileImageStorageKey" IS NULL
      OR ("profileImageMimeType" = 'image/jpeg' AND right("profileImageStorageKey", 4) = '.jpg')
      OR ("profileImageMimeType" = 'image/png' AND right("profileImageStorageKey", 4) = '.png')
      OR ("profileImageMimeType" = 'image/webp' AND right("profileImageStorageKey", 5) = '.webp')
    );

-- MANUAL: reservation keys. The existing CHECK (migration
-- 20261116120000_add_teacher_storage_accounting) is replaced by the same two
-- patterns plus the profile-photo pattern; "category" is compared as text so
-- nothing here depends on how the enum value is cast. The owner CHECK
-- (StorageReservation_storageKey_owner) already covers every category.
ALTER TABLE "StorageReservation" DROP CONSTRAINT "StorageReservation_storageKey_format";
ALTER TABLE "StorageReservation"
  ADD CONSTRAINT "StorageReservation_storageKey_format"
    CHECK (
      ("category"::text = 'NOTE' AND "storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Lectures/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Notes/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[0-9a-f]{32}\.(pdf|png|jpg|webp|docx|doc|pptx|ppt|xlsx|xls|txt|zip)$')
      OR ("category"::text = 'SUBMISSION' AND "storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Lectures/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Assignments/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Submissions/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[0-9a-f]{32}\.pdf$')
      OR ("category"::text = 'PROFILE_IMAGE' AND "storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Profile/Photo/[0-9a-f]{32}\.(jpg|png|webp)$')
    );

-- MANUAL: restore the default lock timeout for the rest of the session.
RESET lock_timeout;
