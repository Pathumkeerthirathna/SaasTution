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
