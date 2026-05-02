DO $$
BEGIN
  CREATE TYPE "GradeLevel" AS ENUM (
    'GRADE_01',
    'GRADE_02',
    'GRADE_03',
    'GRADE_04',
    'GRADE_05',
    'GRADE_06',
    'GRADE_07',
    'GRADE_08',
    'GRADE_09',
    'GRADE_10',
    'GRADE_11',
    'GRADE_12',
    'GRADE_13'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Student"
ADD COLUMN "grade_new" "GradeLevel";

UPDATE "Student"
SET "grade_new" = CASE
  WHEN "grade" IS NULL OR btrim("grade") = '' THEN NULL
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('1', '01') THEN 'GRADE_01'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('2', '02') THEN 'GRADE_02'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('3', '03') THEN 'GRADE_03'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('4', '04') THEN 'GRADE_04'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('5', '05') THEN 'GRADE_05'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('6', '06') THEN 'GRADE_06'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('7', '07') THEN 'GRADE_07'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('8', '08') THEN 'GRADE_08'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') IN ('9', '09') THEN 'GRADE_09'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') = '10' THEN 'GRADE_10'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') = '11' THEN 'GRADE_11'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') = '12' THEN 'GRADE_12'::"GradeLevel"
  WHEN regexp_replace(upper("grade"), '[^0-9]', '', 'g') = '13' THEN 'GRADE_13'::"GradeLevel"
  ELSE NULL
END;

ALTER TABLE "Student"
DROP COLUMN "grade";

ALTER TABLE "Student"
RENAME COLUMN "grade_new" TO "grade";
