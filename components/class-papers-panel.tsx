"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  ScrollText,
  Plus,
  X,
  CalendarClock,
  Users,
  CheckCircle2,
  FileText,
  ExternalLink,
  Trash2,
  Clock,
  Award,
  ChevronDown,
} from "lucide-react";

type ClassOption = { id: string; name: string };

type PaperListItem = {
  id: string;
  name: string;
  description: string | null;
  pdfName: string;
  pdfMimeType: string;
  maxMarks: number | null;
  startTime: string;
  endTime: string;
  createdAt: string;
  classId: string;
  className: string;
  totalStudents: number;
  submittedCount: number;
  markedCount: number;
};

type PaperSubmission = {
  id: string;
  studentId: string;
  studentName: string;
  registrationNumber: string | null;
  submitted: boolean;
  submittedAt: string | null;
  hasFile: boolean;
  submissionFileName: string | null;
  marks: number | null;
  markedAt: string | null;
};

type PaperDetail = PaperListItem & { submissions: PaperSubmission[] };

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
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ClassPapersPanel() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [papers, setPapers] = useState<PaperListItem[]>([]);
  const [classId, setClassId] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    async function loadClasses() {
      try {
        const res = await fetch("/api/classes?page=1&pageSize=100", { cache: "no-store" });
        const json = (await res.json()) as { success: boolean; data?: { id: string; name: string }[] };
        if (res.ok && json.success) {
          setClasses((json.data ?? []).map((c) => ({ id: c.id, name: c.name })));
        }
      } catch {
        /* ignore */
      }
    }
    void loadClasses();
  }, []);

  const loadPapers = useCallback(async () => {
    setIsLoading(true);
    try {
      const qs = classId ? `?classId=${encodeURIComponent(classId)}` : "";
      const res = await fetch(`/api/class-papers${qs}`, { cache: "no-store" });
      const json = (await res.json()) as { success: boolean; data?: { papers: PaperListItem[] } };
      if (!res.ok || !json.success) throw new Error(readErr(json, "Failed to load papers."));
      setPapers(json.data?.papers ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load papers.");
    } finally {
      setIsLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  const loadDetail = useCallback(async (paperId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/class-papers/${paperId}`, { cache: "no-store" });
      const json = (await res.json()) as { success: boolean; data?: { paper: PaperDetail } };
      if (!res.ok || !json.success || !json.data) throw new Error(readErr(json, "Failed to load paper."));
      setDetail(json.data.paper);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load paper.");
      setExpandedId(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function toggleExpand(paperId: string) {
    if (expandedId === paperId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(paperId);
    setDetail(null);
    void loadDetail(paperId);
  }

  async function deletePaper(paper: PaperListItem) {
    if (!window.confirm(`Remove "${paper.name}"? Students will no longer see it.`)) return;
    try {
      const res = await fetch(`/api/class-papers/${paper.id}`, { method: "DELETE" });
      const json = (await res.json()) as { success: boolean };
      if (!res.ok || !json.success) throw new Error(readErr(json, "Failed to remove paper."));
      toast.success("Paper removed.");
      if (expandedId === paper.id) {
        setExpandedId(null);
        setDetail(null);
      }
      void loadPapers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove paper.");
    }
  }

  return (
    <section className="mt-1 overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
            <ScrollText size={17} />
          </span>
          <div>
            <h1 className="text-sm font-bold text-slate-900">Papers</h1>
            <p className="text-xs text-slate-500">Publish papers and mark student submissions.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          <Plus size={14} />
          New paper
        </button>
      </header>

      <div className="p-3">
        <div className="mb-3">
          <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Class</label>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {isLoading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : papers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
            No papers yet. Click <span className="font-semibold">New paper</span> to add one.
          </div>
        ) : (
          <div className="space-y-2.5">
            {papers.map((paper) => {
              const now = Date.now();
              const start = new Date(paper.startTime).getTime();
              const end = new Date(paper.endTime).getTime();
              const window =
                now < start ? "Upcoming" : now > end ? "Closed" : "Open";
              const windowCls =
                window === "Open"
                  ? "bg-emerald-100 text-emerald-700"
                  : window === "Upcoming"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-slate-200 text-slate-600";
              const expanded = expandedId === paper.id;

              return (
                <div key={paper.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="truncate text-sm font-semibold text-slate-900">{paper.name}</h3>
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${windowCls}`}
                          >
                            {window}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                            {paper.className}
                          </span>
                        </div>
                        {paper.description ? (
                          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{paper.description}</p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock size={11} />
                            {fmtDateTime(paper.startTime)} → {fmtDateTime(paper.endTime)}
                          </span>
                          {paper.maxMarks != null ? (
                            <span className="inline-flex items-center gap-1">
                              <Award size={11} />
                              Max {paper.maxMarks}
                            </span>
                          ) : null}
                          <span className="inline-flex items-center gap-1">
                            <Clock size={11} />
                            Added {fmtDate(paper.createdAt)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                            <Users size={10} />
                            {paper.totalStudents} students
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            <CheckCircle2 size={10} />
                            {paper.submittedCount}/{paper.totalStudents} submitted
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                            <Award size={10} />
                            {paper.markedCount}/{paper.totalStudents} marked
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <a
                          href={`/api/class-papers/${paper.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <FileText size={11} />
                          Preview <ExternalLink size={10} />
                        </a>
                        <button
                          type="button"
                          onClick={() => void deletePaper(paper)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50"
                        >
                          <Trash2 size={11} />
                          Remove
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => toggleExpand(paper.id)}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
                    >
                      <ChevronDown
                        size={12}
                        className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                      />
                      {expanded ? "Hide submissions" : "View submissions & mark"}
                    </button>
                  </div>

                  {expanded ? (
                    <div className="border-t border-slate-100 bg-slate-50/60 p-3">
                      {detailLoading || !detail ? (
                        <div className="space-y-1.5">
                          {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="h-9 animate-pulse rounded bg-slate-200/70" />
                          ))}
                        </div>
                      ) : (
                        <SubmissionsTable
                          detail={detail}
                          onSaved={(row) => {
                            setDetail((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    submissions: prev.submissions.map((s) =>
                                      s.id === row.id ? { ...s, marks: row.marks, markedAt: row.markedAt } : s
                                    ),
                                  }
                                : prev
                            );
                            void loadPapers();
                          }}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showCreate ? (
        <CreatePaperModal
          classes={classes}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void loadPapers();
          }}
        />
      ) : null}
    </section>
  );
}

function SubmissionsTable({
  detail,
  onSaved,
}: {
  detail: PaperDetail;
  onSaved: (row: { id: string; marks: number | null; markedAt: string | null }) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-400">
            <th className="px-2 py-1.5">Student</th>
            <th className="px-2 py-1.5">Submission</th>
            <th className="px-2 py-1.5">Marks{detail.maxMarks != null ? ` / ${detail.maxMarks}` : ""}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {detail.submissions.map((s) => (
            <SubmissionRow key={s.id} paperId={detail.id} maxMarks={detail.maxMarks} sub={s} onSaved={onSaved} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubmissionRow({
  paperId,
  maxMarks,
  sub,
  onSaved,
}: {
  paperId: string;
  maxMarks: number | null;
  sub: PaperSubmission;
  onSaved: (row: { id: string; marks: number | null; markedAt: string | null }) => void;
}) {
  const [marks, setMarks] = useState(sub.marks != null ? String(sub.marks) : "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/class-papers/${paperId}/submissions/${sub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marks: marks.trim() === "" ? null : Number(marks) }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { id: string; marks: number | null; markedAt: string | null };
      };
      if (!res.ok || !json.success || !json.data) throw new Error(readErr(json, "Failed to save marks."));
      toast.success(`Saved marks for ${sub.studentName}.`);
      onSaved(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save marks.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="bg-white">
      <td className="px-2 py-2">
        <p className="font-semibold text-slate-800">{sub.studentName}</p>
        {sub.registrationNumber ? (
          <p className="text-[10px] text-slate-400">{sub.registrationNumber}</p>
        ) : null}
      </td>
      <td className="px-2 py-2">
        {sub.submitted ? (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex w-fit items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
              <CheckCircle2 size={10} />
              {sub.submittedAt ? fmtDateTime(sub.submittedAt) : "Submitted"}
            </span>
            {sub.hasFile ? (
              <a
                href={`/api/class-papers/${paperId}/submissions/${sub.id}/file`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:underline"
              >
                <FileText size={10} />
                View answer <ExternalLink size={9} />
              </a>
            ) : null}
          </div>
        ) : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
            Not submitted
          </span>
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            max={maxMarks ?? undefined}
            step="0.5"
            value={marks}
            onChange={(e) => setMarks(e.target.value)}
            className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs outline-none focus:border-emerald-400"
            placeholder="—"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? "…" : "Save"}
          </button>
          {sub.markedAt ? (
            <span className="text-[10px] text-slate-400">✓ {fmtDate(sub.markedAt)}</span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function CreatePaperModal({
  classes,
  onClose,
  onCreated,
}: {
  classes: ClassOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const defaults = useMemo(() => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    return { start: toLocalInput(start), end: toLocalInput(end) };
  }, []);

  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [maxMarks, setMaxMarks] = useState("");
  const [startTime, setStartTime] = useState(defaults.start);
  const [endTime, setEndTime] = useState(defaults.end);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!classId) return setError("Select a class.");
    if (!name.trim()) return setError("Enter a paper name.");
    if (!file) return setError("Upload the paper file (PDF or image).");
    if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
      return setError("End time must be after the start time.");
    }

    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("classId", classId);
      fd.set("name", name.trim());
      fd.set("description", description.trim());
      fd.set("maxMarks", maxMarks.trim());
      fd.set("startTime", new Date(startTime).toISOString());
      fd.set("endTime", new Date(endTime).toISOString());
      fd.set("file", file);

      const res = await fetch("/api/class-papers", { method: "POST", body: fd });
      const json = (await res.json()) as { success: boolean; data?: { assignedStudents: number } };
      if (!res.ok || !json.success) throw new Error(readErr(json, "Failed to create paper."));
      toast.success(`Paper created for ${json.data?.assignedStudents ?? 0} students.`);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create paper.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px]"
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <form
          onSubmit={handleSubmit}
          className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-bold text-slate-900">New paper</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
            >
              <X size={14} />
            </button>
          </div>

          <div className="space-y-3 px-4 py-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Class *</label>
              <select
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
              >
                <option value="">Select a class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Paper name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-emerald-400"
                placeholder="e.g. Unit 3 – Algebra Paper"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={1000}
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-emerald-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-slate-500">Start time *</label>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-emerald-400"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-slate-500">End time *</label>
                <input
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-emerald-400"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Max marks</label>
              <input
                type="number"
                min={1}
                step="0.5"
                value={maxMarks}
                onChange={(e) => setMaxMarks(e.target.value)}
                className="w-32 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-emerald-400"
                placeholder="Optional"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">
                Paper file * <span className="font-normal text-slate-400">(PDF or image)</span>
              </label>
              <input
                type="file"
                accept=".pdf,image/png,image/jpeg,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 file:mr-2 file:rounded-md file:border-0 file:bg-emerald-600 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white hover:file:bg-emerald-700"
              />
              {file ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  {file.name} · {(file.size / (1024 * 1024)).toFixed(2)} MB
                </p>
              ) : null}
            </div>

            <p className="rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
              All active students of the selected class are added automatically.
            </p>

            {error ? (
              <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{error}</p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Plus size={13} />
              {submitting ? "Creating…" : "Create paper"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
