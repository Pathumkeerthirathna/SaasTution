import { z } from "zod";

/**
 * Grade 0: the grade of a student who has no school grade (revision, adult or
 * ungraded learners). It is a real Grade row with the fixed id 0 (inserted by
 * migration 20261127120000_add_grade_zero and by prisma/GradeSeeder.ts), so a
 * student in it has the normal Student -> Grade relationship.
 *
 * - Teacher-facing screens (student management, filters, import templates and
 *   previews, exports) list and show it like any other grade.
 * - Student / family-facing displays never show it (displayGradeForStudent).
 * - Whenever no grade is given, the server assigns it explicitly
 *   (resolveOptionalGradeId); the Student.gradeId column default (6) is
 *   never relied on.
 *
 * 0 is a real grade id: never test a grade id for truthiness (`gradeId ? …`,
 * `gradeId || undefined`, `.filter(Boolean)`) — that would treat Grade 0 as
 * "no grade".
 */
export const GRADE_ZERO_ID = 0;

export const GRADE_ZERO_DESC = "Grade 0";

export const INVALID_GRADE_MESSAGE = "Please select a valid grade.";

export function isGradeZero(gradeId: number | null | undefined): boolean {
  return gradeId === GRADE_ZERO_ID;
}

export type GradeIdResolution = { ok: true; gradeId: number } | { ok: false };

/**
 * A requested grade id, for every student-creation path:
 * - missing / null / blank text -> Grade 0;
 * - a whole number >= 0 (number, or digit-only text such as a spreadsheet
 *   cell) -> that grade, Grade 0 included;
 * - anything else -> not a grade (the caller rejects it).
 * Whether the grade exists is checked separately against the database.
 */
export function resolveOptionalGradeId(value: unknown): GradeIdResolution {
  if (value === undefined || value === null) return { ok: true, gradeId: GRADE_ZERO_ID };

  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return { ok: true, gradeId: GRADE_ZERO_ID };
    if (!/^\d+$/.test(text)) return { ok: false };
    return resolveOptionalGradeId(Number(text));
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return { ok: true, gradeId: value };
  }

  return { ok: false };
}

/**
 * Zod field for a grade id in a request body: omitted or null -> Grade 0; a
 * whole number >= 0 is kept (Grade 0 included). Text is not accepted (JSON
 * clients send numbers).
 */
export const optionalGradeIdSchema = z
  .number({ error: INVALID_GRADE_MESSAGE })
  .int(INVALID_GRADE_MESSAGE)
  .min(0, INVALID_GRADE_MESSAGE)
  .nullish()
  .transform((value) => value ?? GRADE_ZERO_ID);

/**
 * The grade filter of a list or export query (`?grade=`): absent or blank ->
 * no filter (every grade); a whole number >= 0 -> that grade, Grade 0
 * included; anything else -> no filter.
 */
export function parseGradeFilter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const gradeId = Number(text);
  return Number.isSafeInteger(gradeId) ? gradeId : undefined;
}

/**
 * The grade label for a STUDENT- or FAMILY-facing display: null (show no
 * grade) for Grade 0 or a missing grade. Teacher-facing screens show
 * GradeDesc directly instead.
 */
export function displayGradeForStudent(
  grade: { id: number; GradeDesc: string } | null | undefined
): string | null {
  if (!grade || isGradeZero(grade.id)) return null;
  return grade.GradeDesc;
}
