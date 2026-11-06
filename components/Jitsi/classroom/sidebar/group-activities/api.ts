"use client";

// Group Activities API client (the breakout-activities routes; the existing
// { success, data } / { success: false, error: { message, code, details } }
// envelope). Everything is scoped to the classroom's session id.

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; code?: string; details?: unknown };

export async function groupApi<T>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
    const body = (await response.json().catch(() => null)) as
      | { success: true; data: T }
      | { success: false; error?: { message?: string; code?: string; details?: unknown } }
      | null;
    if (response.ok && body && body.success) return { ok: true, status: response.status, data: body.data };
    const error = body && !body.success ? body.error : undefined;
    return { ok: false, status: response.status, message: error?.message ?? "Something went wrong. Please try again.", code: error?.code, details: error?.details };
  } catch {
    return { ok: false, status: 0, message: "Network error. Check your connection and try again." };
  }
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const groupUrls = (sessionId: string) => {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/breakout-activities`;
  return {
    teacherOverview: `${base}/groups`,
    teacherMembers: `${base}/groups/members`,
    teacherCreateAssignment: `${base}/groups/assignments`,
    teacherCreateQuiz: `${base}/groups/quizzes`,
    teacherAssignment: (id: string) => `${base}/groups/assignments/${id}`,
    teacherSubmissionFile: (id: string) => `${base}/groups/assignments/${id}/submission/file`,
    teacherQuiz: (id: string) => `${base}/groups/quizzes/${id}`,
    teacherGrading: (id: string) => `${base}/groups/quizzes/${id}/grading`,
    // The existing activity routes: publish / close (unchanged).
    assignmentState: (id: string) => `${base}/assignments/${id}`,
    quizState: (id: string) => `${base}/quizzes/${id}`,
    teacherBrief: (id: string) => `${base}/assignments/${id}/brief`,
    myGroup: `${base}/me/group`,
    myAssignment: (id: string) => `${base}/me/group/assignments/${id}`,
    myBrief: (id: string) => `${base}/me/group/assignments/${id}/brief`,
    mySubmission: (id: string) => `${base}/me/group/assignments/${id}/submission`,
    mySubmissionFile: (id: string) => `${base}/me/group/assignments/${id}/submission/file`,
    myQuiz: (id: string) => `${base}/me/group/quizzes/${id}`,
    myAttempt: (id: string) => `${base}/me/group/quizzes/${id}/attempt`,
    mySubmit: (id: string) => `${base}/me/group/quizzes/${id}/attempt/submit`,
  };
};

export type Person = { id: string; name: string };

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
