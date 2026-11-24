/*
 * Pure helpers of the student Notes page (components/student-portal/notes/
 * student-notes-client.tsx): request URLs, the file-URL check, labels and
 * error messages. No React, no DOM: tested directly (tests/ui/student-notes-page.test.tsx).
 */

import type { ResourceLock } from "@/components/student-portal/locked-resource";

export type StudentNotesClass = { id: string; name: string };
export type StudentNotesLecture = { id: string; title: string; date: string };

/** A note of GET /api/student/classes/[id]/notes (services/class-notes-service.ts, Stage 1). */
export type StudentNote = {
  id: string;
  lectureId: string;
  title: string;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string | null;
  resourceAccess: ResourceLock;
  /** The existing student file route; null while the note's month is locked. */
  fileUrl: string | null;
};

export type StudentNotesResponse = {
  class: { id: string; name: string };
  section: "GENERAL" | "LECTURE";
  lecture: { id: string; title: string; date: string; isDefault: boolean };
  notes: StudentNote[];
};

/** General Notes (no lecture) or one normal lecture's notes of the class (the Stage 1 API). */
export function studentNotesUrl(classId: string, lectureId?: string | null): string {
  const base = `/api/student/classes/${encodeURIComponent(classId)}/notes`;
  return lectureId ? `${base}?lectureId=${encodeURIComponent(lectureId)}` : base;
}

export const STUDENT_LECTURES_PAGE_SIZE = 20;

/**
 * One page of the class's lectures for the selector: the existing student
 * lectures API with `scheduled=1` (real lectures only, newest first; it never
 * returns a class's default lecture, and only for an active enrolment).
 */
export function studentLecturesUrl(classId: string, page: number): string {
  const query = new URLSearchParams({ classId, scheduled: "1", page: String(page), limit: String(STUDENT_LECTURES_PAGE_SIZE) });
  return `/api/student/lectures?${query.toString()}`;
}

/**
 * The only file URLs the page will open: the existing student file route
 * (/api/student/lectures/{id}/notes/{id}/file) exactly as the API sent it.
 * Anything else (another origin, another route, path tricks) is refused, so
 * a link is never built from or followed to something the server did not
 * grant; the route itself re-checks enrolment and the monthly lock.
 */
export function safeNoteFileUrl(note: Pick<StudentNote, "fileUrl" | "resourceAccess">): string | null {
  if (note.resourceAccess?.locked || !note.fileUrl) return null;
  return /^\/api\/student\/lectures\/[A-Za-z0-9-]+\/notes\/[A-Za-z0-9-]+\/file$/.test(note.fileUrl) ? note.fileUrl : null;
}

const UPLOADED_AT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Colombo",
});

const LECTURE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

/** "24 Nov 2026, 14:05" (Sri Lankan time), or the legacy wording when the upload time was not recorded. */
export function uploadedLabel(uploadedAt: string | null): string {
  const ms = uploadedAt ? Date.parse(uploadedAt) : Number.NaN;
  return Number.isNaN(ms) ? "Upload date not recorded" : `Uploaded ${UPLOADED_AT.format(new Date(ms))}`;
}

/** "Kinematics · 24 Nov 2026" (Sri Lankan date). */
export function studentLectureLabel(lecture: StudentNotesLecture): string {
  const ms = Date.parse(lecture.date);
  return Number.isNaN(ms) ? lecture.title : `${lecture.title} · ${LECTURE_DATE.format(new Date(ms))}`;
}

/** A short file type for the note card. */
export function fileTypeLabel(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type === "application/pdf") return "PDF";
  if (type.startsWith("image/")) return "Image";
  if (type.includes("wordprocessingml") || type === "application/msword") return "Word";
  if (type.includes("presentationml") || type === "application/vnd.ms-powerpoint") return "PowerPoint";
  if (type.includes("spreadsheetml") || type === "application/vnd.ms-excel") return "Excel";
  if (type === "text/plain") return "Text";
  if (type === "application/zip") return "ZIP";
  return "File";
}

export function formatNoteSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The message for a failed list or file request, by status (the server's own message when it sent one). */
export function noteRequestErrorMessage(status: number, serverMessage: string | null | undefined, what: "notes" | "lectures" | "file"): string {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (what === "file") {
    if (status === 403) return serverMessage || "This note is locked until the payment for its month is made.";
    if (status === 404) return "This note is no longer available.";
    return "Could not open the file. Please try again.";
  }
  if (status === 404 && what === "notes") return serverMessage || "This class or lecture is not available.";
  if (status === 409) return serverMessage || "General Notes are not set up for this class yet.";
  if (serverMessage) return serverMessage;
  return what === "notes" ? "Could not load the notes. Please try again." : "Could not load the lectures of this class. Please try again.";
}

/** A safe download file name from the note title (the route sends its own name for direct downloads). */
export function downloadName(title: string, mimeType: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "note";
  const ext = mimeType === "application/pdf" ? ".pdf" : mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : "";
  return ext && !base.toLowerCase().endsWith(ext) ? `${base}${ext}` : base;
}
