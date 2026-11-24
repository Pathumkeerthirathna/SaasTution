-- ---------------------------------------------------------------------------
-- MANUAL, ONE-OFF: give every existing class its default lecture
-- (Lecture.isDefault = true; lib/default-lecture.ts, docs/default-lecture.md).
--
-- NOT a migration and never run automatically. Run it by hand with psql,
-- AFTER migration 20261129120000_add_lecture_is_default is applied and the
-- default-lecture code is deployed, once the schema and code are reviewed:
--
--   psql "<database url>" -v ON_ERROR_STOP=1 -f docs/sql/default-lecture-backfill.sql
--
-- What it does: one INSERT, in one transaction. For every class (active or
-- deactivated: status is not filtered) that has no default lecture yet, it
-- creates exactly the row createClassForTeacher creates for a new class:
--   id          a new UUID (gen_random_uuid(), PostgreSQL 13+; Prisma's
--               @default(uuid()) ids are the same UUID v4 text form)
--   title       'General Notes' (display only; never used to find it)
--   date        the class's own "createdAt": a real UTC instant, like every
--               Lecture.date (the app shows it in Sri Lankan time)
--   endDate     NULL (the CHECK Lecture_endDate_after_date allows NULL)
--   classStatus 'SCHEDULED', status 0 (the column defaults)
--   createdAt   now, as UTC digits (timestamp(3) without time zone holds UTC,
--               as Prisma writes it): explicit, so the server's TimeZone
--               setting cannot shift it
--   isDefault   true
--
-- Safe to run more than once: classes that already have a default lecture
-- are skipped (NOT EXISTS), and ON CONFLICT on the partial unique index
-- "Lecture_one_default_per_class" also skips a class whose default lecture
-- was created concurrently (a class created while this runs). It inserts
-- nothing else and updates or deletes nothing.
--
-- Check afterwards (both must return 0 rows):
--   SELECT c."id" FROM "Class" c
--    WHERE NOT EXISTS (SELECT 1 FROM "Lecture" l WHERE l."classId" = c."id" AND l."isDefault");
--   SELECT "classId" FROM "Lecture" WHERE "isDefault" GROUP BY "classId" HAVING count(*) > 1;
-- ---------------------------------------------------------------------------

BEGIN;

-- Fail instead of waiting indefinitely for a lock on "Class" / "Lecture".
SET LOCAL lock_timeout = '5s';

INSERT INTO "Lecture" ("id", "title", "date", "endDate", "classId", "classStatus", "createdAt", "status", "isDefault")
SELECT
  gen_random_uuid()::text,
  'General Notes',
  c."createdAt",
  NULL,
  c."id",
  'SCHEDULED',
  (now() AT TIME ZONE 'UTC')::timestamp(3),
  0,
  true
FROM "Class" c
WHERE NOT EXISTS (
  SELECT 1 FROM "Lecture" l WHERE l."classId" = c."id" AND l."isDefault" = true
)
ON CONFLICT ("classId") WHERE "isDefault" = true DO NOTHING;

COMMIT;
