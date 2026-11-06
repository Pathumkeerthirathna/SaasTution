"use client";

// End Session with Group Activities. When the session has GROUP breakout
// activities the server answers the End Session POST with 409
// GROUP_ACTIVITIES_DECISION_REQUIRED (nothing changed); the teacher then
// chooses to keep or delete them and the POST is repeated with that choice.
// Without GROUP activities the first POST simply ends the session, as before:
// no dialog is shown.

import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { AlertTriangle, Archive, Trash2 } from "lucide-react";

export type GroupEndDecision = "preserve" | "delete";

export type GroupEndSummary = {
  assignments: number;
  quizzes: number;
  rooms: number;
  submittedAssignments: number;
  submittedQuizzes: number;
};

type EndPayload = {
  success?: boolean;
  data?: {
    youtubeCleanup?: { status?: string; reason?: string };
    groupActivities?: { decision?: GroupEndDecision; cleanup?: { status?: string } };
  };
  error?: { code?: string; message?: string; details?: { summary?: GroupEndSummary } };
};

export type EndSessionResult = { response: Response; data: EndPayload };

async function postSessionEnd(sessionId: string, decision?: GroupEndDecision): Promise<EndSessionResult> {
  const response = await fetch(`/api/sessions/${sessionId}/end`, {
    method: "POST",
    ...(decision ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupActivities: decision }) } : {}),
  });
  const data = (await response.json()) as EndPayload;
  return { response, data };
}

/**
 * POST End Session; when the server asks for the Group Activities decision,
 * `ask` shows the dialog and the POST is repeated with the choice. Null when
 * the teacher cancelled (the session keeps running).
 */
export async function endSessionWithGroupDecision(
  sessionId: string,
  ask: (summary: GroupEndSummary) => Promise<GroupEndDecision | null>
): Promise<EndSessionResult | null> {
  const first = await postSessionEnd(sessionId);
  if (first.response.status !== 409 || first.data.error?.code !== "GROUP_ACTIVITIES_DECISION_REQUIRED") return first;
  const summary = first.data.error.details?.summary ?? { assignments: 0, quizzes: 0, rooms: 0, submittedAssignments: 0, submittedQuizzes: 0 };
  const decision = await ask(summary);
  if (!decision) return null;
  return postSessionEnd(sessionId, decision);
}

/** Group Activities files the server could not remove yet: said, not hidden (they are retried later). */
export function showGroupCleanupWarning(data: EndPayload) {
  if (data.data?.groupActivities?.cleanup?.status === "pending") {
    toast("Group activities were removed from the session, but some of their files could not be deleted yet. They will be cleaned up later.", {
      icon: "⚠️",
      duration: 8000,
    });
  }
}

/** The decision dialog, opened by `ask` (resolves with the choice, or null on Cancel). */
export function useGroupEndDecision(): { ask: (summary: GroupEndSummary) => Promise<GroupEndDecision | null>; dialog: ReactNode } {
  const [pending, setPending] = useState<{ summary: GroupEndSummary; resolve: (decision: GroupEndDecision | null) => void } | null>(null);

  const ask = useCallback(
    (summary: GroupEndSummary) => new Promise<GroupEndDecision | null>((resolve) => setPending({ summary, resolve })),
    []
  );

  const choose = (decision: GroupEndDecision | null) => {
    pending?.resolve(decision);
    setPending(null);
  };

  const dialog = pending && typeof document !== "undefined" ? createPortal(<GroupEndDecisionDialog summary={pending.summary} onChoose={choose} />, document.body) : null;
  return { ask, dialog };
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function GroupEndDecisionDialog({ summary, onChoose }: { summary: GroupEndSummary; onChoose: (decision: GroupEndDecision | null) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-end-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/50 px-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start gap-3 p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0">
            <h3 id="group-end-title" className="text-sm font-semibold text-slate-900">
              This session has group activities
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              {plural(summary.assignments, "group assignment")} and {plural(summary.quizzes, "group quiz", "group quizzes")}
              {summary.rooms ? ` in ${plural(summary.rooms, "breakout room")}` : ""}
              {" "}({plural(summary.submittedAssignments, "submitted assignment")}, {plural(summary.submittedQuizzes, "submitted quiz", "submitted quizzes")}).
              What should happen to them when the session ends?
            </p>
            <p className="mt-2 text-[12px] leading-5 text-slate-500">Individual activities are not affected by this choice.</p>
            {confirmDelete ? (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] font-medium leading-5 text-red-700">
                Deleting removes the group assignments, quizzes, group members, shared work, answers, results and their files for this session. This cannot be undone.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={() => onChoose(null)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            Cancel
          </button>
          {confirmDelete ? (
            <button
              type="button"
              onClick={() => onChoose("delete")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-red-700"
            >
              <Trash2 size={14} /> Delete and end session
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-red-600 transition hover:bg-red-50"
            >
              <Trash2 size={14} /> Delete group activities
            </button>
          )}
          <button
            type="button"
            onClick={() => onChoose("preserve")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90"
          >
            <Archive size={14} /> Keep group activities
          </button>
        </div>
      </div>
    </div>
  );
}
