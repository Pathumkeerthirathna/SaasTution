-- Grade 0: the grade of a student with no school grade (lib/grade.ts).
-- Data only: one Grade row with the fixed id 0. No table, column, default,
-- constraint or sequence changes; no existing Grade or Student row is changed.
--
-- Safe to run on any database:
--   * id 0 already "Grade 0"            -> nothing to do (re-run safe).
--   * id 0 exists with another name      -> stop: the app would treat that
--                                           grade as Grade 0 (decide by hand).
--   * "Grade 0" exists under another id  -> stop: inserting would create a
--                                           second "Grade 0" (decide by hand).
--   * otherwise                          -> insert (0, 'Grade 0', 1).
-- Stopping raises an error, so the migration fails and changes nothing.
-- The explicit id never touches the id sequence (Grade 1..13 keep theirs).
DO $$
DECLARE
  existing_desc TEXT;
  other_id INTEGER;
BEGIN
  SELECT "GradeDesc" INTO existing_desc FROM "Grade" WHERE "id" = 0;

  IF FOUND THEN
    IF lower(btrim(existing_desc)) = 'grade 0' THEN
      RAISE NOTICE 'Grade 0 (id 0) already exists; nothing to do.';
      RETURN;
    END IF;
    RAISE EXCEPTION 'Grade id 0 already exists as "%" (not "Grade 0"). Resolve it by hand before applying this migration.', existing_desc;
  END IF;

  SELECT "id" INTO other_id FROM "Grade" WHERE lower(btrim("GradeDesc")) = 'grade 0' ORDER BY "id" LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'A "Grade 0" grade already exists with id % (Grade 0 must have id 0). Resolve it by hand before applying this migration.', other_id;
  END IF;

  INSERT INTO "Grade" ("id", "GradeDesc", "Status") VALUES (0, 'Grade 0', 1);
END $$;
