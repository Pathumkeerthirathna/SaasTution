import { TeacherProfileSectionType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";

export type { TeacherProfileSectionType };

/**
 * Default order every teacher starts with. New teachers are seeded with these
 * rows; existing teachers that predate the feature are back-filled the first
 * time their profile page is opened.
 */
export const DEFAULT_PROFILE_SECTIONS: {
  sectionType: TeacherProfileSectionType;
  displayOrder: number;
}[] = [
  { sectionType: "ABOUT_ME", displayOrder: 1 },
  { sectionType: "ANNOUNCEMENTS", displayOrder: 2 },
  { sectionType: "SUBJECTS", displayOrder: 3 },
  { sectionType: "SOCIAL_MEDIA", displayOrder: 4 },
  { sectionType: "QUALIFICATIONS", displayOrder: 5 },
  { sectionType: "ACHIEVEMENTS", displayOrder: 6 },
];

const KNOWN_SECTIONS = new Set<string>(
  DEFAULT_PROFILE_SECTIONS.map((section) => section.sectionType)
);

export type TeacherProfileSectionDto = {
  sectionType: TeacherProfileSectionType;
  displayOrder: number;
};

/**
 * Nested-create payload so a teacher can be created together with its default
 * section order in a single statement.
 */
export function defaultProfileSectionsCreateInput() {
  return {
    create: DEFAULT_PROFILE_SECTIONS.map((section) => ({
      sectionType: section.sectionType,
      displayOrder: section.displayOrder,
    })),
  };
}

function sortSections(
  rows: { sectionType: TeacherProfileSectionType; displayOrder: number }[]
): TeacherProfileSectionDto[] {
  return [...rows].sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Guarantees the teacher has a full set of section rows and returns them in
 * display order. Missing rows (a brand new teacher, or a section type added
 * after the teacher was created) are appended after the current maximum
 * display order.
 */
export async function ensureTeacherProfileSections(
  teacherId: string
): Promise<TeacherProfileSectionDto[]> {
  const existing = await prisma.teacherProfileSection.findMany({
    where: { teacherId },
    select: { sectionType: true, displayOrder: true },
  });

  const existingTypes = new Set(existing.map((row) => row.sectionType));
  const missing = DEFAULT_PROFILE_SECTIONS.filter(
    (section) => !existingTypes.has(section.sectionType)
  );

  if (missing.length === 0) {
    return sortSections(existing);
  }

  const maxOrder = existing.reduce(
    (max, row) => Math.max(max, row.displayOrder),
    0
  );

  await prisma.teacherProfileSection.createMany({
    data: missing.map((section, index) => ({
      teacherId,
      sectionType: section.sectionType,
      // Fresh teacher: use the canonical defaults. Otherwise append.
      displayOrder:
        existing.length === 0 ? section.displayOrder : maxOrder + index + 1,
    })),
    skipDuplicates: true,
  });

  const refreshed = await prisma.teacherProfileSection.findMany({
    where: { teacherId },
    select: { sectionType: true, displayOrder: true },
  });

  return sortSections(refreshed);
}

export async function getTeacherProfileSections(
  teacherId: string
): Promise<TeacherProfileSectionDto[]> {
  return ensureTeacherProfileSections(teacherId);
}

/**
 * Persist a new section order. `orderedTypes` must be a permutation of the
 * teacher's existing section types. Because `(teacherId, displayOrder)` is
 * unique, the update runs in two phases inside a transaction: first every row
 * is pushed into a high, collision-free band, then each row is set to its
 * final 1-based position.
 */
export async function reorderTeacherProfileSections(
  teacherId: string,
  orderedTypes: string[]
): Promise<TeacherProfileSectionDto[]> {
  await ensureTeacherProfileSections(teacherId);

  const current = await prisma.teacherProfileSection.findMany({
    where: { teacherId },
    select: { sectionType: true },
  });

  const currentTypes = current.map((row) => row.sectionType as string).sort();
  const requestedTypes = [...orderedTypes].sort();

  const isPermutation =
    currentTypes.length === requestedTypes.length &&
    currentTypes.every((type, index) => type === requestedTypes[index]) &&
    orderedTypes.every((type) => KNOWN_SECTIONS.has(type));

  if (!isPermutation) {
    throw new AppError(
      "The section order must include every section exactly once.",
      400,
      "VALIDATION_ERROR"
    );
  }

  const OFFSET = 1000;

  await prisma.$transaction([
    prisma.teacherProfileSection.updateMany({
      where: { teacherId },
      data: { displayOrder: { increment: OFFSET } },
    }),
    ...orderedTypes.map((type, index) =>
      prisma.teacherProfileSection.update({
        where: {
          teacherId_sectionType: {
            teacherId,
            sectionType: type as TeacherProfileSectionType,
          },
        },
        data: { displayOrder: index + 1 },
      })
    ),
  ]);

  const updated = await prisma.teacherProfileSection.findMany({
    where: { teacherId },
    select: { sectionType: true, displayOrder: true },
  });

  return sortSections(updated);
}
