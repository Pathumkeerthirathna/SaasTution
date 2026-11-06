// Shapes of the Group Activities API responses used by the panels.

import type { Person } from "./api";

export type ActivityState = "DRAFT" | "PUBLISHED" | "CLOSED";

export type AssignmentProgress = {
  started: boolean;
  revision: number;
  lastEditedBy: Person | null;
  lastEditedAt: string | null;
  submitted: { submittedAt: string | null; submittedBy: Person | null; hasFile: boolean } | null;
};

export type QuizProgress = {
  attemptStatus: "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED" | null;
  answered: number;
  questions: number;
  startedBy?: Person | null;
  deadlineAt?: string | null;
  lastSavedAt?: string | null;
  lastSavedBy?: Person | null;
  submittedAt?: string | null;
  submittedBy?: Person | null;
  finalScore?: number | null;
  totalMarks?: number | null;
};

export type TeacherOverview = {
  sessionActive: boolean;
  rooms: {
    id: string;
    name: string;
    members: Person[];
    assignments: { id: string; title: string; state: ActivityState; progress: AssignmentProgress }[];
    quizzes: { id: string; title: string; state: ActivityState; totalMarks: number | null; progress: QuizProgress }[];
  }[];
};

export type StudentOverview = {
  group: { room: { id: string; name: string }; members: Person[] } | null;
  assignments: { id: string; title: string; state: ActivityState; progress: AssignmentProgress }[];
  quizzes: { id: string; title: string; state: ActivityState; questionCount: number; progress: QuizProgress }[];
};

export type GroupWork = {
  answerText: string;
  revision: number;
  lastEditedBy: Person | null;
  lastEditedAt: string | null;
  submission: { submittedAt: string | null; submittedBy: Person | null; members: Person[]; file: { fileName: string; fileSize: number | null } | null } | null;
};

export type StudentQuestion = {
  id: string;
  kind: "single" | "multiple" | "true_false" | "short";
  prompt: string;
  marks: number;
  options?: { id: string; text: string }[];
};

export type ReviewItem = StudentQuestion & { answer: unknown; result: string; awarded: number; note?: string } & Record<string, unknown>;

export type StudentQuizView = {
  quiz: { id: string; title: string; state: ActivityState; instructions: string | null; totalMarks: number | null; timeLimitSeconds: number | null; questions?: StudentQuestion[]; questionCount?: number };
  attempt:
    | { attemptStatus: null }
    | { attemptStatus: "IN_PROGRESS"; answers: Record<string, unknown>; revision: number; deadlineAt: string | null; lastSavedAt: string | null }
    | { attemptStatus: "SUBMITTED" | "AUTO_SUBMITTED"; finalScore: number | null; totalMarks: number | null; submittedAt: string | null; review?: ReviewItem[] };
  group: { room: { id: string; name: string }; members: Person[] };
  activity: { startedBy: Person | null; lastSavedAt: string | null; lastSavedBy: Person | null; submittedAt: string | null; submittedBy: Person | null; members: Person[] } | null;
  progress: { answered: number; questions: number } | null;
  serverNow: string;
};
