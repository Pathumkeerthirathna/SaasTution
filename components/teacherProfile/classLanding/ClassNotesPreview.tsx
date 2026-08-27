"use client";

import {
  CheckCircle2,
  Download,
  FileText,
  HardDrive,
  Lock,
} from "lucide-react";

import { ClassNote } from "../../../types/teacherProfileTypes/ClassNote";

interface Props {
  notes: ClassNote[];
}

export default function ClassNotesPreview({
  notes,
}: Props) {
  const previewCount = notes.filter(
    (x) => x.preview
  ).length;

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
              Download preview study materials before enrolling.
            </p>
          </div>
        </div>

        <span className="shrink-0 rounded-full bg-orange-100 px-2.5 py-1 text-[12px] font-semibold text-orange-700">
          {previewCount} Free
        </span>

      </div>

      {/* Body */}
      <div className="space-y-2.5 p-5">

        {notes.map((note) => (
          <div
            key={note.id}
            className={`rounded-lg border transition hover:shadow-sm ${
              note.preview
                ? "border-orange-100 bg-orange-50/40 hover:border-orange-200"
                : "border-slate-200 bg-slate-50 hover:border-slate-300"
            }`}
          >
            <div className="flex items-center justify-between gap-3 p-3">

              <div className="flex min-w-0 flex-1 items-start gap-3">

                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    note.preview ? "bg-orange-100" : "bg-slate-200"
                  }`}
                >
                  {note.preview ? (
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

                    {note.preview && (
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[12px] font-semibold text-orange-700">
                        FREE
                      </span>
                    )}
                  </div>

                  <h3 className="mt-1.5 text-[15px] font-semibold text-slate-900">
                    {note.title}
                  </h3>

                  <p className="mt-0.5 line-clamp-2 text-[14px] leading-5 text-slate-600">
                    {note.description}
                  </p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[13px] text-slate-500">
                    <span className="flex items-center gap-1">
                      <FileText className="h-3.5 w-3.5 text-slate-400" />
                      {note.pages} Pages
                    </span>
                    <span className="flex items-center gap-1">
                      <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                      {note.fileSize}
                    </span>
                  </div>

                </div>

              </div>

              {note.preview ? (
                <button className="flex shrink-0 items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-orange-600">
                  <Download className="h-3.5 w-3.5" />
                  Download
                </button>
              ) : (
                <button className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100">
                  Unlock
                </button>
              )}

            </div>
          </div>
        ))}

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

    </div>
  );
}
