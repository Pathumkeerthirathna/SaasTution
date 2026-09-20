import { TeacherTitle } from "@prisma/client";

export const TEACHER_TITLE_LABELS: Record<TeacherTitle, string> = {
  MR: "Mr.",
  MRS: "Mrs.",
  MS: "Ms.",
  DR: "Dr.",
  PROF: "Prof.",
};

export const TEACHER_TITLE_OPTIONS: TeacherTitle[] = [
  "MR",
  "MRS",
  "MS",
  "DR",
  "PROF",
];

export function formatTeacherTitle(title: TeacherTitle): string {
  return TEACHER_TITLE_LABELS[title];
}

type TeacherNameSource = {
  name: string;
  profile?: { title: TeacherTitle; displayName: string | null } | null;
};

/**
 * A teacher's name with their title, e.g. "Mr. Pathum Kumara".
 * Prefers the public profile's display name and falls back to the account name.
 */
export function formatTeacherFullName(teacher: TeacherNameSource): string {
  const name = teacher.profile?.displayName?.trim() || teacher.name.trim();
  const title = teacher.profile ? `${TEACHER_TITLE_LABELS[teacher.profile.title]} ` : "";

  return `${title}${name}`;
}

/** How a teacher is named inside a live class, e.g. "Mr. Pathum Kumara (Teacher)". */
export function formatTeacherClassroomName(teacher: TeacherNameSource): string {
  return `${formatTeacherFullName(teacher)} (Teacher)`;
}
