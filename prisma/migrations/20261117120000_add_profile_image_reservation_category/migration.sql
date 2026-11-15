-- ---------------------------------------------------------------------------
-- Teacher profile images on unified storage (1 of 2): the reservation
-- category PROFILE_IMAGE.
--
-- Additive only. In a migration of its OWN on purpose: PostgreSQL does not
-- allow a value added by ALTER TYPE ... ADD VALUE to be used in the same
-- transaction, and the next migration
-- (20261117120100_add_teacher_profile_image_storage) refers to it in a CHECK.
--
-- Exactly what `prisma migrate diff` generates for the enum change. Guarded
-- by tests/storage-quota/profile-image-migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- AlterEnum
ALTER TYPE "StorageReservationCategory" ADD VALUE 'PROFILE_IMAGE';
