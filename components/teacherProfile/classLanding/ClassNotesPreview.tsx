"use client";

import { useMemo, useState } from "react";

import {
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Lock,
  X,
} from "lucide-react";

import { ClassPublicNote } from "@/types/teacherProfileTypes/ClassPublicNote";

interface Props {
  notes: ClassPublicNote[];
}

interface LectureGroup {
  lectureId: string;
  lectureTitle: string;
  notes: ClassPublicNote[];
}

function groupByLecture(notes: ClassPublicNote[]): LectureGroup[] {
  const groups: LectureGroup[] = [];
  const index = new Map<string, LectureGroup>();

  for (const note of notes) {
    let group = index.get(note.lectureId);

    if (!group) {
      group = {
        lectureId: note.lectureId,
        lectureTitle: note.lectureTitle,
        notes: [],
      };
      index.set(note.lectureId, group);
      groups.push(group);
    }

    group.notes.push(note);
  }

  return groups;
}

export default function ClassNotesPreview({ notes }: Props) {
  const [previewNote, setPreviewNote] = useState<ClassPublicNote | null>(null);

  const groups = useMemo(() => groupByLecture(notes), [notes]);
  const freeCount = notes.filter((note) => note.access === "FREE").length;

  const previewUrl = previewNote
    ? `/api/public/class-notes/${previewNote.id}/preview`
    : "";

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">

        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100">
            <FileText className="h-4 w-4 text-orange-600" />
          </div>

          <div>
            <h2 className="text-[16px] font-bold text-slate-900">
              Lecture Notes
            </h2>
            <p className="mt-0.5 text-[14px] text-slate-500">
              Preview study materials shared for this class before enrolling.
            </p>
          </div>
        </div>

        {freeCount > 0 && (
          <span className="shrink-0 rounded-full bg-orange-100 px-2.5 py-1 text-[12px] font-semibold text-orange-700">
            {freeCount} Free
          </span>
        )}

      </div>

      {/* Body */}
      <div className="space-y-4 p-5">

        {groups.length === 0 ? (

          <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
            <FileText className="mx-auto h-7 w-7 text-slate-300" />
            <p className="mt-2 text-[14px] font-medium text-slate-600">
              No lecture notes published yet
            </p>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Notes shared by the teacher will appear here once published.
            </p>
          </div>

        ) : (

          groups.map((group) => (
            <div
              key={group.lectureId}
              className="overflow-hidden rounded-lg border border-slate-200"
            >
              {/* Lecture header */}
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-orange-600" />
                  <h3 className="truncate text-[15px] font-semibold text-slate-900">
                    {group.lectureTitle}
                  </h3>
                </div>

                <span className="shrink-0 text-[12px] font-medium text-slate-400">
                  {group.notes.length}{" "}
                  {group.notes.length === 1 ? "note" : "notes"}
                </span>
              </div>

              {/* Notes */}
              <div className="divide-y divide-slate-100">
                {group.notes.map((note) => {
                  const isFree = note.access === "FREE";
                  const canPreview = isFree && (note.isPdf || note.isImage);

                  return (
                    <div
                      key={note.id}
                      onClick={canPreview ? () => setPreviewNote(note) : undefined}
                      onKeyDown={
                        canPreview
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setPreviewNote(note);
                              }
                            }
                          : undefined
                      }
                      role={canPreview ? "button" : undefined}
                      tabIndex={canPreview ? 0 : undefined}
                      className={`flex items-center justify-between gap-3 px-3.5 py-3 ${
                        canPreview
                          ? "cursor-pointer transition hover:bg-orange-50/60 focus:outline-none focus-visible:bg-orange-50/60"
                          : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                            isFree ? "bg-orange-100" : "bg-slate-200"
                          }`}
                        >
                          {isFree ? (
                            <FileText className="h-4 w-4 text-orange-600" />
                          ) : (
                            <Lock className="h-4 w-4 text-slate-500" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">
                              {note.fileType}
                            </span>

                            {isFree ? (
                              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[12px] font-semibold text-orange-700">
                                FREE
                              </span>
                            ) : (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-500">
                                LOCKED
                              </span>
                            )}
                          </div>

                          <h4 className="mt-1.5 text-[15px] font-semibold text-slate-900">
                            {note.title}
                          </h4>

                          <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-slate-500">
                            <span className="flex items-center gap-1">
                              <FileText className="h-3.5 w-3.5 text-slate-400" />
                              {note.fileType}
                            </span>
                            <span>{note.fileSize}</span>
                          </div>
                        </div>
                      </div>

                      {isFree ? (
                        canPreview ? (
                          <span className="flex shrink-0 items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-[13px] font-semibold text-white">
                            <Eye className="h-3.5 w-3.5" />
                            Preview
                          </span>
                        ) : (
                          <a
                            href={`/api/public/class-notes/${note.id}/preview?download=1`}
                            className="flex shrink-0 items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-orange-600"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </a>
                        )
                      ) : (
                        <span className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[13px] font-semibold text-slate-400">
                          <Lock className="h-3.5 w-3.5" />
                          Locked
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))

        )}

        {/* Bottom CTA */}
        <div className="rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
            <div>
              <h4 className="text-[14px] font-semibold text-slate-900">
                Unlock Complete Study Pack
              </h4>
              <p className="mt-0.5 text-[13px] leading-5 text-slate-600">
                Register to access all lecture notes, revision guides, model papers, assignments, quizzes and future downloads.
              </p>
            </div>
          </div>
        </div>

      </div>

      {/* Note preview viewer (PDF or image) */}
      {previewNote && (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/60"
            onClick={() => setPreviewNote(null)}
            aria-hidden
          />
          <aside className="fixed inset-y-0 right-0 z-[90] flex h-full w-full max-w-3xl flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-slate-900">
                  {previewNote.title}
                </p>
                <p className="truncate text-[12px] text-slate-500">
                  {previewNote.lectureTitle}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={`/api/public/class-notes/${previewNote.id}/preview?download=1`}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewNote(null)}
                  aria-label="Close preview"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-slate-100 p-2 sm:p-3">
              {previewNote.isImage ? (
                <div className="flex min-h-full items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={previewNote.id}
                    src={previewUrl}
                    alt={previewNote.title}
                    className="max-h-full max-w-full rounded-lg bg-white shadow-sm"
                  />
                </div>
              ) : (
                <iframe
                  key={previewNote.id}
                  title={`Preview ${previewNote.title}`}
                  src={previewUrl}
                  className="h-full w-full rounded-lg bg-white shadow-sm"
                />
              )}
            </div>
          </aside>
        </>
      )}

    </div>
  );
}
