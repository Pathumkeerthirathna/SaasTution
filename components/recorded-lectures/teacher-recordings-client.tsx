"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clapperboard,
  Film,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { blobByteSource, inspectMp4 } from "@/lib/recorded-lectures/mp4-inspect";
import type { TeacherRecordingDto } from "@/lib/recorded-lectures/teacher-dto";
import { formatDuration, formatLectureDateTime } from "@/components/student-portal/recorded-lectures/recording-helpers";
import { RECORDING_DELETION_LABELS, RECORDING_DELETION_WARNING } from "@/lib/permanent-deletion/client";

import { fingerprintFile, openRecordingStore, sameFingerprint, type RecordingStore } from "./recording-store";
import { formatBytes, progressPercent, RecordingUploader, uploadMessage, type UploadSnapshot } from "./upload-engine";
import { UploadFormatGuide } from "./upload-format-guide";

/*
 * Teacher Recorded Lectures management for one lecture: the parts with their
 * status, uploading a new part (existing RL-3 protocol through the upload
 * engine), pause / resume / retry / cancel, editing the title and part
 * number, owner preview of READY parts and soft delete. Students only ever
 * see READY parts (RL-4.2 access filter); nothing here changes that.
 */

export type TeacherRecordingsInitial = {
  lecture: { id: string; title: string; date: string; className: string };
  recordings: TeacherRecordingDto[];
  nextPartNumber: number;
  limits: { maxPartBytes: number; chunkBytes: number; maxPartsPerLecture: number | null; maxMoovBytes: number };
};

type ActiveUpload = {
  key: string;
  title: string;
  partNumber: number;
  fileName: string;
  file: File;
  uploader: RecordingUploader;
  snapshot: UploadSnapshot;
};

type Notice = { tone: "error" | "success" | "pending"; text: string; signIn?: boolean } | null;

const STATE_LABEL: Record<TeacherRecordingDto["state"], string> = {
  UPLOADING: "Uploading",
  VERIFYING: "Checking the video",
  READY: "Ready — visible to students",
  FAILED: "Failed",
};

const STATE_TONE: Record<TeacherRecordingDto["state"], string> = {
  UPLOADING: "bg-amber-50 text-amber-800 border-amber-200",
  VERIFYING: "bg-sky-50 text-sky-800 border-sky-200",
  READY: "bg-emerald-50 text-emerald-800 border-emerald-200",
  FAILED: "bg-rose-50 text-rose-800 border-rose-200",
};

const PHASE_LABEL: Record<UploadSnapshot["phase"], string> = {
  idle: "Waiting",
  starting: "Starting…",
  uploading: "Uploading…",
  retrying: "Connection problem — retrying…",
  paused: "Paused",
  completing: "Finishing…",
  verifying: "Checking the video…",
  ready: "Done — ready for students",
  failed: "The video was not accepted",
  expired: "Expired",
  cancelling: "Cancelling…",
  cancelled: "Cancelled",
  error: "Stopped",
};

async function readJson(response: Response): Promise<{ data?: unknown; error?: { code?: string; message?: string } }> {
  try {
    return (await response.json()) as { data?: unknown; error?: { code?: string; message?: string } };
  } catch {
    return {};
  }
}

function titleFromFileName(name: string): string {
  return name.replace(/\.mp4$/i, "").replace(/[_]+/g, " ").trim().slice(0, 200);
}

export function TeacherRecordingsClient({ teacherId, initial }: { teacherId: string; initial: TeacherRecordingsInitial }) {
  const lectureId = initial.lecture.id;
  const [recordings, setRecordings] = useState<TeacherRecordingDto[]>(initial.recordings);
  const [nextPart, setNextPart] = useState(initial.nextPartNumber);
  const [uploads, setUploads] = useState<ActiveUpload[]>([]);
  const [notice, setNotice] = useState<Notice>(null);

  // Upload form
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [partNumber, setPartNumber] = useState(String(initial.nextPartNumber));
  const [checking, setChecking] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Edit / delete / preview
  const [editing, setEditing] = useState<{ id: string; title: string; partNumber: string; error: string | null; saving: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TeacherRecordingDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<TeacherRecordingDto | null>(null);
  const [resumeFor, setResumeFor] = useState<TeacherRecordingDto | null>(null);
  const resumeInput = useRef<HTMLInputElement | null>(null);

  const storeRef = useRef<RecordingStore | null>(null);
  useEffect(() => {
    void openRecordingStore().then((store) => {
      storeRef.current = store;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/lectures/${encodeURIComponent(lectureId)}/recorded-lectures`, { cache: "no-store" });
      const json = await readJson(response);
      if (response.status === 401) {
        setNotice({ tone: "error", text: "Your session has ended. Please sign in again.", signIn: true });
        return;
      }
      if (!response.ok) return;
      const data = json.data as { recordings: TeacherRecordingDto[]; nextPartNumber: number };
      setRecordings(data.recordings);
      setNextPart(data.nextPartNumber);
    } catch {
      // Keep the last list; the next refresh tries again.
    }
  }, [lectureId]);

  // While a part is being verified (by this tab or another), refresh until it settles.
  const anyVerifying = recordings.some((r) => r.state === "VERIFYING");
  useEffect(() => {
    if (!anyVerifying) return;
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [anyVerifying, refresh]);

  // Warn before leaving while bytes are being sent (the upload can be resumed, but not from a closed tab).
  const sending = uploads.some((u) => ["starting", "uploading", "retrying", "completing"].includes(u.snapshot.phase));
  useEffect(() => {
    if (!sending) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [sending]);

  const activeByUploadId = useMemo(() => new Map(uploads.filter((u) => u.snapshot.uploadId).map((u) => [u.snapshot.uploadId as string, u])), [uploads]);

  function updateUpload(key: string, snapshot: UploadSnapshot) {
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, snapshot } : u)));
  }

  async function runUpload(entry: ActiveUpload) {
    const result = await entry.uploader.run();
    updateUpload(entry.key, result);
    if (result.uploadId && storeRef.current && (result.phase === "ready" || result.phase === "cancelled" || result.phase === "expired" || result.phase === "failed")) {
      await storeRef.current.deleteFileUpload(result.uploadId).catch(() => undefined);
    }
    await refresh();
  }

  function createUploader(
    key: string,
    selected: File,
    declaration: { title: string; partNumber: number },
    existing?: { uploadId: string }
  ): RecordingUploader {
    let remembered = Boolean(existing);
    return new RecordingUploader(
      lectureId,
      selected,
      { title: declaration.title, partNumber: declaration.partNumber, fileName: selected.name, sizeBytes: selected.size },
      {
        fetch: (input, init) => fetch(input, init),
        onUpdate: (snapshot) => {
          updateUpload(key, snapshot);
          if (!remembered && snapshot.uploadId && storeRef.current) {
            remembered = true;
            const uploadId = snapshot.uploadId;
            // Remember which file this upload is, so it can be resumed after a refresh.
            void fingerprintFile(selected)
              .then((fingerprint) =>
                storeRef.current?.putFileUpload({ uploadId, teacherId, lectureId, recordingId: snapshot.recordingId, fingerprint, createdAt: Date.now() })
              )
              .catch(() => undefined);
          }
        },
      },
      existing
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    if (!file) return setFormError("Choose an MP4 video file.");
    if (!/\.mp4$/i.test(file.name)) return setFormError("Only MP4 files (.mp4) can be uploaded.");
    if (file.size === 0) return setFormError("The file is empty.");
    if (file.size > initial.limits.maxPartBytes) return setFormError(`Each recording part can be at most ${formatBytes(initial.limits.maxPartBytes)}.`);
    const cleanTitle = title.trim();
    if (!cleanTitle) return setFormError("Enter a title for this part.");
    if (Array.from(cleanTitle).length > 200) return setFormError("The title must be at most 200 characters.");
    const part = Number(partNumber);
    if (!Number.isInteger(part) || part < 1) return setFormError("The part number must be a whole number of at least 1.");
    if (initial.limits.maxPartsPerLecture !== null && part > initial.limits.maxPartsPerLecture) {
      return setFormError(`A lecture can have at most ${initial.limits.maxPartsPerLecture} parts.`);
    }
    if (recordings.some((r) => r.partNumber === part && r.state !== "FAILED")) {
      return setFormError(`Part ${part} already exists. Choose another part number, or delete the existing part first.`);
    }

    // The server's MP4 rules, checked on this computer before any byte is sent.
    setChecking(true);
    try {
      const inspected = await inspectMp4(blobByteSource(file), { maxMoovBytes: initial.limits.maxMoovBytes });
      if (!inspected.ok) return setFormError("This file cannot be used: recorded lectures must be MP4 with H.264 video and AAC audio.");
      if (inspected.info.durationSeconds === null) return setFormError("This video's length cannot be read, so it would be rejected. Export it again as MP4.");
    } catch {
      return setFormError("The file could not be read. Choose it again.");
    } finally {
      setChecking(false);
    }

    const key = `${Date.now()}-${Math.random()}`;
    const uploader = createUploader(key, file, { title: cleanTitle, partNumber: part });
    const entry: ActiveUpload = { key, title: cleanTitle, partNumber: part, fileName: file.name, file, uploader, snapshot: uploader.state };
    setUploads((prev) => [...prev, entry]);
    setFile(null);
    setTitle("");
    setPartNumber(String(part + 1));
    if (fileInput.current) fileInput.current.value = "";
    void runUpload(entry);
  }

  function retry(entry: ActiveUpload) {
    if (entry.snapshot.phase === "expired" || (entry.snapshot.phase === "error" && !entry.snapshot.uploadId)) {
      // A new upload of the same file (the expired one cannot continue).
      const key = `${Date.now()}-${Math.random()}`;
      const uploader = createUploader(key, entry.file, { title: entry.title, partNumber: entry.partNumber });
      const next: ActiveUpload = { ...entry, key, uploader, snapshot: uploader.state };
      setUploads((prev) => prev.map((u) => (u.key === entry.key ? next : u)));
      void runUpload(next);
      return;
    }
    void runUpload(entry);
  }

  async function cancel(entry: ActiveUpload) {
    const result = await entry.uploader.cancel();
    updateUpload(entry.key, result);
    if (result.uploadId) await storeRef.current?.deleteFileUpload(result.uploadId).catch(() => undefined);
    await refresh();
  }

  function dismiss(entry: ActiveUpload) {
    setUploads((prev) => prev.filter((u) => u.key !== entry.key));
  }

  // ---- Resume an upload started earlier (this or another session): re-select the same file ----

  async function onResumeFile(selected: File | undefined) {
    const target = resumeFor;
    setResumeFor(null);
    if (resumeInput.current) resumeInput.current.value = "";
    if (!selected || !target?.upload) return;
    const expected = target.upload.expectedBytes;
    if (selected.size !== expected) {
      setNotice({ tone: "error", text: "That is not the file this upload was started with (its size is different)." });
      return;
    }
    const pending = (await storeRef.current?.listFileUploads(teacherId, lectureId))?.find((p) => p.uploadId === target.upload?.uploadId);
    if (pending) {
      const fingerprint = await fingerprintFile(selected);
      if (!sameFingerprint(pending.fingerprint, fingerprint)) {
        setNotice({ tone: "error", text: "That is not the file this upload was started with. Choose the original file." });
        return;
      }
    } else if (selected.name.replace(/\.mp4$/i, "") !== target.fileName.replace(/\.mp4$/i, "")) {
      setNotice({ tone: "error", text: `Choose the original file (${target.fileName}).` });
      return;
    }
    const key = `${Date.now()}-${Math.random()}`;
    const uploader = createUploader(key, selected, { title: target.title, partNumber: target.partNumber }, { uploadId: target.upload.uploadId });
    const entry: ActiveUpload = { key, title: target.title, partNumber: target.partNumber, fileName: selected.name, file: selected, uploader, snapshot: uploader.state };
    setUploads((prev) => [...prev, entry]);
    void runUpload(entry);
  }

  // ---- Edit / delete ----

  async function saveEdit() {
    if (!editing) return;
    const part = Number(editing.partNumber);
    if (!editing.title.trim()) return setEditing({ ...editing, error: "Enter a title." });
    if (!Number.isInteger(part) || part < 1) return setEditing({ ...editing, error: "The part number must be a whole number of at least 1." });
    setEditing({ ...editing, saving: true, error: null });
    try {
      const response = await fetch(`/api/recorded-lectures/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editing.title, partNumber: part }),
      });
      const json = await readJson(response);
      if (!response.ok) {
        const code = json.error?.code;
        const text =
          code === "PART_NUMBER_IN_USE"
            ? "Another part of this lecture already uses that part number."
            : code === "UPLOAD_DECLARATION_INVALID"
              ? json.error?.message ?? "The details are not valid."
              : response.status === 401
                ? "Your session has ended. Please sign in again."
                : "The recording could not be updated.";
        setEditing((prev) => (prev ? { ...prev, saving: false, error: text } : prev));
        return;
      }
      setEditing(null);
      setNotice({ tone: "success", text: "Recording updated." });
      await refresh();
    } catch {
      setEditing((prev) => (prev ? { ...prev, saving: false, error: "The connection failed. Please try again." } : prev));
    }
  }

  async function doDelete() {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    try {
      const target = confirmDelete;
      const local = target.upload ? activeByUploadId.get(target.upload.uploadId) : undefined;
      local?.uploader.pause();
      const response = await fetch(`/api/recorded-lectures/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const json = await readJson(response);
      if (!response.ok) {
        const code = json.error?.code;
        setNotice({
          tone: "error",
          text:
            code === "UPLOAD_COMPLETING"
              ? "This part is being checked right now. Delete it when the check has finished."
              : code === "CHUNK_IN_PROGRESS" || code === "UPLOAD_BUSY"
                ? "Part of the upload is still being received. Please try again in a moment."
                : uploadMessage(code),
        });
        return;
      }
      if (local) dismiss(local);
      if (target.upload) await storeRef.current?.deleteFileUpload(target.upload.uploadId).catch(() => undefined);
      // Stage 3.6: success only when the file is gone (200 deleted); 202 = removed, file deletion pending.
      const pending = response.status === 202 && (json.data as { pending?: unknown } | undefined)?.pending === true;
      setNotice(
        pending
          ? { tone: "pending", text: `Part ${target.partNumber} was ${RECORDING_DELETION_LABELS.pending}` }
          : { tone: "success", text: `Part ${target.partNumber} was ${RECORDING_DELETION_LABELS.deleted}` }
      );
      setConfirmDelete(null);
      await refresh();
    } catch {
      setNotice({ tone: "error", text: "The connection failed. Please try again." });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link href="/dashboard/lectures" className="inline-flex min-h-[40px] items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
            <ArrowLeft size={14} aria-hidden />
            Lectures
          </Link>
          <h1 className="break-words text-lg font-bold text-slate-900">Recorded lectures — {initial.lecture.title}</h1>
          <p className="text-xs text-slate-600">
            {initial.lecture.className} · {formatLectureDateTime(initial.lecture.date)}
          </p>
        </div>
        <Link
          href={`/dashboard/lectures/${encodeURIComponent(lectureId)}/recordings/studio`}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:opacity-90"
        >
          <Clapperboard size={16} aria-hidden />
          Record class
        </Link>
      </div>

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-sm ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : notice.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}
        >
          <span>
            {notice.text}{" "}
            {notice.signIn ? (
              <Link href="/login" className="font-semibold underline">
                Sign in
              </Link>
            ) : null}
          </span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center">
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : null}

      {/* Upload a file */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Upload size={16} className="text-brand-700" aria-hidden />
          Upload a recording
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          MP4 video with H.264 video and AAC audio, up to {formatBytes(initial.limits.maxPartBytes)} per part. Students see a part only after it has
          been uploaded and checked.
        </p>
        <UploadFormatGuide maxSizeLabel={formatBytes(initial.limits.maxPartBytes)} />
        <form onSubmit={onSubmit} className="mt-3 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_120px_auto] md:items-end" noValidate>
          <label className="block text-xs font-semibold text-slate-700">
            Video file
            <input
              ref={fileInput}
              type="file"
              accept="video/mp4,.mp4"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                setFormError(null);
                if (chosen && !title.trim()) setTitle(titleFromFileName(chosen.name) || initial.lecture.title);
              }}
              className="mt-1 block w-full text-xs file:mr-3 file:min-h-[40px] file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:text-xs file:font-semibold file:text-brand-700"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-3 text-sm"
              placeholder="e.g. Algebra — introduction"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            Part number
            <input
              value={partNumber}
              onChange={(event) => setPartNumber(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-3 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={checking}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {checking ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Upload size={16} aria-hidden />}
            {checking ? "Checking…" : "Upload"}
          </button>
        </form>
        <p className="mt-2 text-[11px] text-slate-500">Next free part number: {nextPart}</p>
        {formError ? (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {formError}
          </p>
        ) : null}
      </section>

      {/* Uploads running in this tab */}
      {uploads.length > 0 ? (
        <section className="space-y-2" aria-label="Uploads in progress">
          {uploads.map((entry) => {
            const s = entry.snapshot;
            const pct = progressPercent(s.receivedBytes, s.expectedBytes);
            const active = ["starting", "uploading", "retrying", "completing"].includes(s.phase);
            const terminal = ["ready", "cancelled"].includes(s.phase);
            return (
              <div key={entry.key} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-words text-sm font-semibold text-slate-900">
                    Part {entry.partNumber} · {entry.title}
                  </p>
                  <span className="text-xs font-semibold text-slate-600">{PHASE_LABEL[s.phase]}</span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Upload progress for part ${entry.partNumber}`}>
                  <div className={`h-full ${s.phase === "failed" || s.phase === "error" ? "bg-rose-500" : "bg-brand-700"}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {pct}% · {formatBytes(s.receivedBytes)} of {formatBytes(s.expectedBytes)} · {entry.fileName}
                </p>
                {s.message ? (
                  <p role={s.phase === "retrying" ? "status" : "alert"} className="mt-1 text-xs text-rose-700">
                    {s.message}{" "}
                    {s.signIn ? (
                      <Link href="/login" className="font-semibold underline">
                        Sign in
                      </Link>
                    ) : null}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {active && s.phase !== "completing" ? (
                    <button type="button" onClick={() => entry.uploader.pause()} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">
                      <Pause size={14} aria-hidden /> Pause
                    </button>
                  ) : null}
                  {["paused", "error", "expired"].includes(s.phase) && !s.signIn ? (
                    <button type="button" onClick={() => retry(entry)} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-brand-700 px-3 text-xs font-semibold text-brand-700">
                      <RotateCcw size={14} aria-hidden /> {s.phase === "paused" ? "Resume" : s.phase === "expired" ? "Start again" : "Try again"}
                    </button>
                  ) : null}
                  {!terminal && s.phase !== "verifying" && s.phase !== "cancelling" && s.phase !== "failed" ? (
                    <button type="button" onClick={() => void cancel(entry)} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-rose-300 px-3 text-xs font-semibold text-rose-700">
                      <X size={14} aria-hidden /> Cancel upload
                    </button>
                  ) : null}
                  {terminal || s.phase === "failed" ? (
                    <button type="button" onClick={() => dismiss(entry)} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">
                      Dismiss
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {/* Parts */}
      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <h2 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-900">
          <Film size={16} className="text-brand-700" aria-hidden />
          Parts ({recordings.length})
        </h2>
        {recordings.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">No recordings yet. Upload a video or record the class.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recordings.map((r) => {
              const local = r.upload ? activeByUploadId.get(r.upload.uploadId) : undefined;
              const isEditing = editing?.id === r.id;
              return (
                <li key={r.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p className="break-words text-sm font-semibold text-slate-900">
                        Part {r.partNumber} · {r.title}
                      </p>
                      <p className="break-words text-[11px] text-slate-500">
                        {r.fileName} · {formatBytes(Number(r.sizeBytes))} · {formatDuration(r.durationSeconds)} · uploaded {formatLectureDateTime(r.createdAt)}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATE_TONE[r.state]}`}>
                      {r.state === "READY" ? <CheckCircle2 size={12} aria-hidden /> : r.state === "FAILED" ? <AlertTriangle size={12} aria-hidden /> : <Loader2 size={12} className="animate-spin" aria-hidden />}
                      {STATE_LABEL[r.state]}
                      {r.state === "UPLOADING" && r.upload ? ` ${progressPercent(r.upload.receivedBytes, r.upload.expectedBytes)}%` : ""}
                    </span>
                  </div>
                  {r.state === "FAILED" && r.failureMessage ? <p className="text-xs text-rose-700">{r.failureMessage}</p> : null}
                  {r.state === "UPLOADING" && !local && r.upload?.uploadState === "ACTIVE" ? (
                    <p className="text-xs text-amber-800">
                      This upload is not finished. To continue it, choose the same file again (on this or another computer), or delete this part.
                    </p>
                  ) : null}

                  {isEditing && editing ? (
                    <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_120px_auto] sm:items-end">
                      <label className="block text-xs font-semibold text-slate-700">
                        Title
                        <input
                          value={editing.title}
                          maxLength={200}
                          onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                          className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-3 text-sm"
                        />
                      </label>
                      <label className="block text-xs font-semibold text-slate-700">
                        Part number
                        <input
                          value={editing.partNumber}
                          inputMode="numeric"
                          onChange={(event) => setEditing({ ...editing, partNumber: event.target.value.replace(/[^0-9]/g, "") })}
                          className="mt-1 block min-h-[40px] w-full rounded-lg border border-slate-300 px-3 text-sm"
                        />
                      </label>
                      <div className="flex gap-2">
                        <button type="button" disabled={editing.saving} onClick={() => void saveEdit()} className="inline-flex min-h-[40px] items-center rounded-lg bg-brand-700 px-3 text-xs font-semibold text-white disabled:opacity-60">
                          {editing.saving ? "Saving…" : "Save"}
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">
                          Cancel
                        </button>
                      </div>
                      {editing.error ? (
                        <p role="alert" className="text-xs text-rose-700 sm:col-span-3">
                          {editing.error}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {r.previewUrl ? (
                      <button type="button" onClick={() => setPreview(r)} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">
                        <Play size={14} aria-hidden /> Preview
                      </button>
                    ) : null}
                    {r.state === "UPLOADING" && !local && r.upload?.uploadState === "ACTIVE" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setResumeFor(r);
                          resumeInput.current?.click();
                        }}
                        className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-brand-700 px-3 text-xs font-semibold text-brand-700"
                      >
                        <RotateCcw size={14} aria-hidden /> Resume upload
                      </button>
                    ) : null}
                    {r.state !== "VERIFYING" ? (
                      <button
                        type="button"
                        onClick={() => setEditing({ id: r.id, title: r.title, partNumber: String(r.partNumber), error: null, saving: false })}
                        className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700"
                      >
                        <Pencil size={14} aria-hidden /> Edit
                      </button>
                    ) : null}
                    {r.state !== "VERIFYING" ? (
                      <button type="button" onClick={() => setConfirmDelete(r)} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-rose-300 px-3 text-xs font-semibold text-rose-700">
                        <Trash2 size={14} aria-hidden /> {r.state === "UPLOADING" ? "Cancel & delete" : "Delete"}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <input
        ref={resumeInput}
        type="file"
        accept="video/mp4,.mp4"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => void onResumeFile(event.target.files?.[0])}
      />

      {confirmDelete ? (
        <div role="dialog" aria-modal="true" aria-labelledby="rl-delete-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 id="rl-delete-title" className="text-base font-bold text-slate-900">
              Permanently delete part {confirmDelete.partNumber}?
            </h3>
            <p className="mt-2 break-words text-sm text-slate-600">
              “{confirmDelete.title}”: {RECORDING_DELETION_WARNING}
              {confirmDelete.state === "UPLOADING" ? " The unfinished upload is cancelled." : ""}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)} className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">
                Keep it
              </button>
              <button type="button" disabled={deleting} onClick={() => void doDelete()} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white disabled:opacity-60">
                {deleting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview?.previewUrl ? (
        <div role="dialog" aria-modal="true" aria-label={`Preview of part ${preview.partNumber}`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-3xl overflow-hidden rounded-2xl bg-black">
            <div className="flex items-center justify-between gap-3 px-4 py-2 text-white">
              <p className="min-w-0 break-words text-sm font-semibold">
                Part {preview.partNumber} · {preview.title}
              </p>
              <button type="button" onClick={() => setPreview(null)} aria-label="Close preview" className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg hover:bg-white/10">
                <X size={16} aria-hidden />
              </button>
            </div>
            {/* The owner-only stream (authorised on every Range request); never preloaded beyond metadata. */}
            <video key={preview.id} src={preview.previewUrl} controls playsInline preload="metadata" controlsList="nodownload" className="aspect-video w-full bg-black" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
