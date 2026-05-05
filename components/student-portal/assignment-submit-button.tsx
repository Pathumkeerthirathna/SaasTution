"use client";

import { FormEvent, useState, useTransition } from "react";

import { StatusBadge } from "@/components/student-portal/student-ui";

type Props = {
  assignmentId: string;
  dueDate: Date;
  initialSubmission: {
    id: string;
    notes: string | null;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    sizeBytes: number;
    submittedAt: Date;
  } | null;
};

export function AssignmentSubmitButton({ assignmentId, dueDate, initialSubmission }: Props) {
  const [submission, setSubmission] = useState(initialSubmission);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(initialSubmission?.notes ?? "");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isOverdue = dueDate < new Date();

  function openPanel() {
    setNotes(submission?.notes ?? "");
    setSelectedFile(null);
    setError(null);
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    setError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!selectedFile) {
      setError("Please choose a PDF file to submit.");
      return;
    }

    if (selectedFile.type !== "application/pdf") {
      setError("Only PDF files are allowed.");
      return;
    }

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.append("notes", notes.trim());
        formData.append("file", selectedFile);

        const response = await fetch(`/api/assignments/${assignmentId}/submit`, {
          method: "POST",
          body: formData,
        });

        const payload = (await response.json()) as {
          success: boolean;
          data?: {
            submission: {
              id: string;
              notes: string | null;
              fileName: string;
              fileUrl: string;
              mimeType: string;
              sizeBytes: number;
              submittedAt: string;
            };
          };
          error?: { message?: string };
        };

        if (!response.ok || !payload.success) {
          setError(payload.error?.message ?? "Could not submit. Please try again.");
          return;
        }

        const raw = payload.data!.submission;
        setSubmission({
          ...raw,
          submittedAt: new Date(raw.submittedAt),
        });
        closePanel();
      } catch {
        setError("Network error. Please check your connection and try again.");
      }
    });
  }

  if (submission) {
    return (
      <div className="flex flex-col items-end gap-1">
        <StatusBadge label="SUBMITTED" tone="completed" />
        <p className="text-xs text-slate-500">
          {submission.submittedAt.toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </p>
        <button
          type="button"
          onClick={openPanel}
          className="text-xs text-brand-700 underline underline-offset-2 hover:text-brand-900"
        >
          Edit submission
        </button>
        <a
          href={`/api/assignments/${assignmentId}/submit/file`}
          className="text-xs text-slate-600 underline underline-offset-2 hover:text-slate-900"
        >
          Download PDF
        </a>

        {open ? (
          <SubmissionSidePanel
            assignmentId={assignmentId}
            notes={notes}
            onNotesChange={setNotes}
            selectedFile={selectedFile}
            onFileChange={setSelectedFile}
            onSubmit={handleSubmit}
            onClose={closePanel}
            isPending={isPending}
            error={error}
            isResubmit
            existingFileName={submission.fileName}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {isOverdue ? <StatusBadge label="OVERDUE" tone="overdue" /> : null}
      <button
        type="button"
        onClick={openPanel}
        className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-700 transition-colors"
      >
        {isOverdue ? "Submit late" : "Submit"}
      </button>

      {open ? (
        <SubmissionSidePanel
          assignmentId={assignmentId}
          notes={notes}
          onNotesChange={setNotes}
          selectedFile={selectedFile}
          onFileChange={setSelectedFile}
          onSubmit={handleSubmit}
          onClose={closePanel}
          isPending={isPending}
          error={error}
          isResubmit={false}
          existingFileName={null}
        />
      ) : null}
    </div>
  );
}

type SidePanelProps = {
  assignmentId: string;
  notes: string;
  onNotesChange: (value: string) => void;
  selectedFile: File | null;
  onFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  isPending: boolean;
  error: string | null;
  isResubmit: boolean;
  existingFileName: string | null;
};

function SubmissionSidePanel({
  assignmentId,
  notes,
  onNotesChange,
  selectedFile,
  onFileChange,
  onSubmit,
  onClose,
  isPending,
  error,
  isResubmit,
  existingFileName,
}: SidePanelProps) {
  return (
    <>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close submission panel"
        className="fixed inset-0 z-40 bg-slate-900/35"
      />
      <aside className="fixed inset-y-0 right-0 z-50 w-full max-w-md border-l border-brand-200 bg-white shadow-2xl">
        <form onSubmit={onSubmit} className="flex h-full flex-col">
          <div className="border-b border-brand-200 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-900">
                {isResubmit ? "Update submission" : "Submit assignment"}
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                Close
              </button>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Upload your PDF and add optional notes for your teacher.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div>
              <label htmlFor={`submission-file-${assignmentId}`} className="mb-1.5 block text-sm font-medium text-slate-700">
                PDF file <span className="text-red-500">*</span>
              </label>
              <input
                id={`submission-file-${assignmentId}`}
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
                className="w-full rounded-xl border border-brand-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 file:mr-3 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-brand-800"
              />

              {selectedFile ? (
                <p className="mt-1 text-xs text-slate-500">
                  Selected: {selectedFile.name} ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
                </p>
              ) : existingFileName ? (
                <p className="mt-1 text-xs text-slate-500">Current file: {existingFileName}</p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">No file selected.</p>
              )}

              {existingFileName ? (
                <a
                  href={`/api/assignments/${assignmentId}/submit/file`}
                  className="mt-1 inline-block text-xs text-brand-700 underline underline-offset-2 hover:text-brand-900"
                >
                  Download current submission PDF
                </a>
              ) : null}
            </div>

            <div className="mt-4">
              <label htmlFor={`submission-notes-${assignmentId}`} className="mb-1.5 block text-sm font-medium text-slate-700">
                Notes <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <textarea
                id={`submission-notes-${assignmentId}`}
                rows={8}
                maxLength={3000}
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                placeholder="Write your answer, comments, or clarifications here..."
                className="w-full resize-none rounded-xl border border-brand-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200 transition"
              />
              <p className="mt-1 text-right text-xs text-slate-400">{notes.length} / 3000</p>
            </div>

            {error ? (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-brand-200 px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-lg border border-brand-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-brand-50 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50 transition-colors"
            >
              {isPending ? "Submitting..." : isResubmit ? "Update submission" : "Submit assignment"}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
