import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/*
 * Grade seeder: safe to run again on any database (it never duplicates a
 * grade and never changes or deletes an existing one).
 *
 * - Grade 0 ("no school grade", lib/grade.ts) always has the fixed id 0, as in
 *   migration 20261127120000_add_grade_zero. If id 0 or a "Grade 0" row under
 *   another id already exists, nothing is inserted (a mismatch is reported).
 * - Grade 1..13 are matched by description: a missing one is created with the
 *   next id from the sequence (on an empty table: 1..13 in order).
 */
const GRADE_ZERO = { id: 0, GradeDesc: "Grade 0", Status: 1 };
const NUMBERED_GRADES = Array.from({ length: 13 }, (_, index) => `Grade ${index + 1}`);

const sameDesc = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function seedGradeZero() {
  const byId = await prisma.grade.findUnique({ where: { id: GRADE_ZERO.id } });
  if (byId) {
    if (!sameDesc(byId.GradeDesc, GRADE_ZERO.GradeDesc)) {
      console.warn(`Grade id 0 exists as "${byId.GradeDesc}", not "Grade 0": left unchanged.`);
    }
    return;
  }

  const byDesc = await prisma.grade.findFirst({
    where: { GradeDesc: { equals: GRADE_ZERO.GradeDesc, mode: "insensitive" } },
  });
  if (byDesc) {
    console.warn(`"Grade 0" exists with id ${byDesc.id} (expected id 0): not inserted.`);
    return;
  }

  await prisma.grade.create({ data: GRADE_ZERO });
}

async function main() {
  await seedGradeZero();

  for (const GradeDesc of NUMBERED_GRADES) {
    const existing = await prisma.grade.findFirst({
      where: { GradeDesc: { equals: GradeDesc, mode: "insensitive" } },
      select: { id: true },
    });
    if (!existing) {
      await prisma.grade.create({ data: { GradeDesc, Status: 1 } });
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
