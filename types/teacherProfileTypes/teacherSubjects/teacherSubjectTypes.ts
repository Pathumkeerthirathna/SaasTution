export type TeachingLevel = "PRIMARY" | "OL" | "AL";

export const TEACHING_LEVELS: TeachingLevel[] = ["PRIMARY", "OL", "AL"];

export const TEACHING_LEVEL_LABELS: Record<TeachingLevel, string> = {
  PRIMARY: "Primary",
  OL: "O/L",
  AL: "A/L",
};

export interface Subject {
  id: number;
  name: string;
}

export interface SubjectForm {
  subjectId: number;

  levels: TeachingLevel[];
}

export interface AddTeacherSubjectDto {
  subjectId: number;
  levels: TeachingLevel[];
}

export interface UpdateTeacherSubjectDto {
  subjectId: number;
  levels: TeachingLevel[];
}

/** One subject with every level the teacher teaches it at. */
export interface TeacherSubject {
  id: string;

  subjectId: number;

  levels: TeachingLevel[];

  subject: {
    id: number;
    name: string;
  };
}
