"use client";

// Student: one group assignment. Everyone in the group edits the same answer
// text. Typing is saved automatically (after a short pause) with the revision
// last seen; when someone else saved first, the server answers
// REVISION_CONFLICT with their text: it is shown, and your unsaved text is
// kept beside it so nothing is lost. Any member submits the group's final
// work (the saved text and/or a PDF); after that it is read-only.

import { useCallback, useEffect, useRef, useState } from "react";

import { formatTime, groupApi, groupUrls, jsonInit } from "./api";
import { useGroupResource } from "./hooks";
import type { GroupWork } from "./types";

type Detail = {
  assignment: { id: string; title: string; state: "DRAFT" | "PUBLISHED" | "CLOSED"; instructions: string; brief: { fileName: string } | null };
  group: { room: { id: string; name: string }; members: { id: string; name: string }[] };
  work: GroupWork;
};

const SAVE_DELAY_MS = 1500;

export default function StudentGroupAssignment({ sessionId, assignmentId, onBack }: { sessionId: string; assignmentId: string; onBack: () => void }) {
  const urls = groupUrls(sessionId);
  const resource = useGroupResource<Detail>(urls.myAssignment(assignmentId), (d) => d.activityId === assignmentId || d.kind === "members");
  const [text, setText] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [conflictText, setConflictText] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // Read when a save fires (never captured at typing time), so consecutive
  // saves always send the revision the previous save returned.
  const textRef = useRef(text);
  textRef.current = text;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const savingRef = useRef(false);

  // Take the server's work whenever it changes, unless this member is typing.
  const data = resource.data;
  useEffect(() => {
    if (!data) return;
    if (!dirtyRef.current || data.work.submission) {
      setText(data.work.answerText);
      setRevision(data.work.revision);
      if (data.work.submission) setDirty(false);
    }
  }, [data]);

  const save = useCallback(
    async (value: string, baseRevision: number) => {
      savingRef.current = true;
      setStatus("Saving…");
      const result = await groupApi<{ work: GroupWork }>(urls.myAssignment(assignmentId), jsonInit("PUT", { revision: baseRevision, answerText: value }));
      savingRef.current = false;
      if (result.ok) {
        revisionRef.current = result.data.work.revision;
        setRevision(result.data.work.revision);
        // Typed more while this save was on its way: that text is saved next.
        setDirty(textRef.current !== value);
        setStatus(`Saved ${formatTime(result.data.work.lastEditedAt)}`);
        resource.setData({ ...(resource.data as Detail), work: result.data.work });
        return;
      }
      if (result.code === "REVISION_CONFLICT") {
        const current = (result.details as { work?: GroupWork } | undefined)?.work;
        if (current) {
          setConflictText(value);
          setText(current.answerText);
          setRevision(current.revision);
          setDirty(false);
          setStatus(`${current.lastEditedBy?.name ?? "Someone"} changed the work. Their version is shown; your text is kept below.`);
          void resource.reload();
          return;
        }
      }
      setStatus(result.message);
    },
    [assignmentId, resource, urls]
  );

  const onType = (value: string) => {
    setText(value);
    setDirty(true);
    setStatus(null);
    schedule();
  };

  function schedule() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (savingRef.current) {
        schedule(); // one save at a time
        return;
      }
      void save(textRef.current, revisionRef.current);
    }, SAVE_DELAY_MS);
  }

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  if (resource.loading && !data) return <p className="text-xs text-slate-500">Loading…</p>;
  if (!data) {
    return (
      <div className="space-y-2">
        <button type="button" className="text-xs text-blue-700 hover:underline" onClick={onBack}>
          ← Back
        </button>
        <p className="text-xs text-red-600">{resource.error && !resource.error.ok ? resource.error.message : "Not available."}</p>
      </div>
    );
  }

  const submission = data.work.submission;
  const closed = data.assignment.state === "CLOSED";
  const readOnly = Boolean(submission) || closed;

  const submit = async () => {
    if (dirty) {
      if (timer.current) window.clearTimeout(timer.current);
      setStatus("Saving your latest text first…");
      await save(textRef.current, revisionRef.current);
      return;
    }
    if (!window.confirm("Submit your group's final work? Nobody in the group can change it after this.")) return;
    setSubmitting(true);
    const form = new FormData();
    form.set("revision", String(revision));
    if (file) form.set("file", file);
    const result = await groupApi<{ work: GroupWork; replayed: boolean }>(urls.mySubmission(assignmentId), { method: "POST", body: form });
    setSubmitting(false);
    if (result.ok) {
      setStatus(result.data.replayed ? "Your group had already submitted." : "Submitted.");
      resource.setData({ ...data, work: result.data.work });
      return;
    }
    if (result.code === "REVISION_CONFLICT") {
      setStatus("The work changed just now. Check the latest version, then submit again.");
      void resource.reload();
      return;
    }
    setStatus(result.message);
  };

  return (
    <div className="space-y-2 text-slate-900">
      <button type="button" className="text-xs text-blue-700 hover:underline" onClick={onBack}>
        ← Back
      </button>
      <h4 className="break-words text-sm font-semibold">{data.assignment.title}</h4>
      {data.assignment.instructions ? <p className="whitespace-pre-wrap break-words text-xs text-slate-700">{data.assignment.instructions}</p> : null}
      {data.assignment.brief ? (
        <a className="text-xs font-medium text-blue-700 underline" href={urls.myBrief(assignmentId)} target="_blank" rel="noreferrer">
          Brief: {data.assignment.brief.fileName}
        </a>
      ) : null}
      <p className="break-words text-xs text-slate-600">Group: {data.group.members.map((m) => m?.name).join(", ")}</p>

      <textarea
        aria-label="Group answer"
        className="h-48 w-full rounded-md border border-slate-300 p-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:bg-slate-50"
        value={text}
        disabled={readOnly}
        onChange={(e) => onType(e.target.value)}
        placeholder="Write your group's answer together…"
      />
      <p className="break-words text-[11px] text-slate-500">
        {data.work.lastEditedBy ? `Last edited by ${data.work.lastEditedBy.name} at ${formatTime(data.work.lastEditedAt)}` : "No edits yet."}
        {status ? ` · ${status}` : ""}
      </p>

      {conflictText !== null && !readOnly ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="mb-1 font-medium">Your unsaved text:</p>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{conflictText}</p>
          <div className="mt-1 flex gap-2">
            <button type="button" className="font-semibold underline" onClick={() => onType(`${text}${text && !text.endsWith("\n") ? "\n" : ""}${conflictText}`)}>
              Add it to the group text
            </button>
            <button type="button" className="underline" onClick={() => setConflictText(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {submission ? (
        <p className="rounded-md bg-emerald-50 p-2 text-xs text-emerald-800">
          Submitted by {submission.submittedBy?.name ?? "—"} at {formatTime(submission.submittedAt)}.
          {submission.file ? (
            <>
              {" "}
              <a className="font-medium underline" href={urls.mySubmissionFile(assignmentId)} target="_blank" rel="noreferrer">
                {submission.file.fileName}
              </a>
            </>
          ) : null}
        </p>
      ) : closed ? (
        <p className="rounded-md bg-slate-100 p-2 text-xs text-slate-700">This assignment is closed.</p>
      ) : (
        <div className="space-y-1.5 rounded-md border border-slate-200 p-2">
          <label className="block text-xs text-slate-600">
            Attach a PDF (optional)
            <input type="file" accept="application/pdf" className="mt-1 block w-full text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button
            type="button"
            disabled={submitting}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            onClick={() => void submit()}
          >
            Submit group work
          </button>
        </div>
      )}
    </div>
  );
}

