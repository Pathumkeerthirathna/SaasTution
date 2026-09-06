"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import toast from "react-hot-toast";

import { focusElementId, useFocusHighlight } from "@/components/student-portal/use-focus-highlight";

type Submission = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  submittedAt: string;
  isLate: boolean;
  marks: number | null;
  reviewedAt: string | null;
};

type StudentRow = {
  id: string;
  name: string;
  registrationNumber: string | null;
  hasSubmitted: boolean;
  latestSubmittedAt: string | null;
  submissions: Submission[];
};

type Detail = {
  item: { id: string; title: string; paperEndAt: string | null };
  classroom: { id: string; name: string };
  students: StudentRow[];
};

function readErr(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const e = (payload as { error?: { message?: string } }).error;
    if (e?.message) return e.message;
  }
  return fallback;
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function BundlePaperSubmissionsModal({
  bundleId,
  itemId,
  itemTitle,
  focusSubmissionId,
  onClose,
}: {
  bundleId: string;
  itemId: string;
  itemTitle: string;
  focusSubmissionId?: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/material-bundles/${bundleId}/items/${itemId}/submissions`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { success: boolean; data?: Detail };
      if (!res.ok || !json.success || !json.data) throw new Error(readErr(json, "Failed to load submissions."));
      setDetail(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load submissions.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, itemId]);

  useFocusHighlight(!loading && Boolean(detail) && Boolean(focusSubmissionId));

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px]"
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#264867]">
                Paper submissions
              </p>
              <p className="truncate text-sm font-bold text-slate-900">{detail?.item.title ?? itemTitle}</p>
              {detail ? (
                <p className="text-xs text-slate-500">{detail.classroom.name}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
            >
              <X size={14} />
            </button>
          </div>

          <div className="p-4">
            {error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
            ) : loading || !detail ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
                ))}
              </div>
            ) : detail.students.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
                No students are enrolled in this class.
              </p>
            ) : (
              <div className="space-y-2">
                {detail.students.map((student) => {
                  const latest = student.submissions[0] ?? null;
                  return (
                    <StudentSubmissionRow
                      key={student.id}
                      bundleId={bundleId}
                      itemId={itemId}
                      student={student}
                      latest={latest}
                      focused={Boolean(latest && latest.id === focusSubmissionId)}
                      onSaved={(row) => {
                        setDetail((prev) => {
                          if (!prev) return prev;
                          return {
                            ...prev,
                            students: prev.students.map((s) =>
                              s.id === student.id && s.submissions[0]
                                ? {
                                    ...s,
                                    submissions: [
                                      { ...s.submissions[0], marks: row.marks, reviewedAt: row.reviewedAt },
                                      ...s.submissions.slice(1),
                                    ],
                                  }
                                : s
                            ),
                          };
                        });
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StudentSubmissionRow({
  bundleId,
  itemId,
  student,
  latest,
  focused,
  onSaved,
}: {
  bundleId: string;
  itemId: string;
  student: StudentRow;
  latest: Submission | null;
  focused: boolean;
  onSaved: (row: { marks: number | null; reviewedAt: string | null }) => void;
}) {
  const [marks, setMarks] = useState(latest?.marks != null ? String(latest.marks) : "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!latest) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/material-bundles/${bundleId}/items/${itemId}/submissions/${latest.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ marks: marks.trim() === "" ? null : Number(marks) }),
        }
      );
      const json = (await res.json()) as {
        success: boolean;
        data?: { marks: number | null; reviewedAt: string | null };
      };
      if (!res.ok || !json.success || !json.data) throw new Error(readErr(json, "Failed to save marks."));
      toast.success(`Saved marks for ${student.name}.`);
      onSaved(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save marks.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      id={latest ? focusElementId(latest.id) : undefined}
      className={`scroll-mt-24 rounded-lg border p-3 text-xs ${
        focused ? "border-[#8fb0cd] bg-[#eef3f8]/40" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold text-slate-900">{student.name}</p>
          {student.registrationNumber ? (
            <p className="text-[10px] text-slate-400">{student.registrationNumber}</p>
          ) : null}
        </div>

        {latest ? (
          <div className="flex flex-col items-end gap-0.5">
            <span className="inline-flex items-center gap-1 rounded bg-[#dce7f1] px-1.5 py-0.5 text-[10px] font-semibold text-[#264867]">
              <CheckCircle2 size={10} />
              {fmtDateTime(latest.submittedAt)}
              {latest.isLate ? " (late)" : ""}
            </span>
            <a
              href={`/api/material-bundles/${bundleId}/items/${itemId}/submissions/${latest.id}/file`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#264867] hover:underline"
            >
              <FileText size={10} />
              View answer <ExternalLink size={9} />
            </a>
          </div>
        ) : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
            Not submitted
          </span>
        )}
      </div>

      {latest ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Marks</label>
          <input
            type="number"
            min={0}
            step="0.5"
            value={marks}
            onChange={(e) => setMarks(e.target.value)}
            className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs outline-none focus:border-[#5b85ac]"
            placeholder="—"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-lg bg-[#32598A] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#264867] disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
          </button>
          {latest.reviewedAt ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-[#264867]">
              <CheckCircle2 size={10} /> Reviewed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
              <Clock size={10} /> Not reviewed
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
