"use client";

import {
  CheckCircle2,
  Download,
  FileText,
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
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

  {/* Header */}

  <div className="border-b border-slate-100 bg-gradient-to-r from-orange-50 via-white to-emerald-50 px-5 py-4">

    <div className="flex items-center justify-between">

      <div>

        <h2 className="text-lg font-bold text-slate-900">
          Lecture Notes
        </h2>

        <p className="mt-0.5 text-xs text-slate-500">
          Download preview study materials before enrolling.
        </p>

      </div>

      <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
        {previewCount} Free Downloads
      </span>

    </div>

  </div>

  {/* Body */}

  <div className="space-y-3 p-5">

    {notes.map((note) => (

      <div
        key={note.id}
        className={`rounded-xl border transition hover:border-orange-200 hover:shadow-sm ${
          note.preview
            ? "border-orange-100 bg-orange-50/40"
            : "border-slate-200 bg-slate-50"
        }`}
      >

        <div className="flex items-center justify-between gap-4 p-4">

          {/* Left */}

          <div className="flex flex-1 items-start gap-3">

            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                note.preview
                  ? "bg-orange-100"
                  : "bg-slate-200"
              }`}
            >

              {note.preview ? (
                <FileText className="h-5 w-5 text-orange-600" />
              ) : (
                <Lock className="h-5 w-5 text-slate-500" />
              )}

            </div>

            <div className="min-w-0 flex-1">

              <div className="flex flex-wrap items-center gap-2">

                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                  {note.fileType}
                </span>

                {note.preview && (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                    FREE
                  </span>
                )}

              </div>

              <h3 className="mt-2 text-base font-semibold text-slate-900">
                {note.title}
              </h3>

              <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-600">
                {note.description}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">

                <span>
                  📄 {note.pages} Pages
                </span>

                <span>
                  💾 {note.fileSize}
                </span>

              </div>

            </div>

          </div>

          {/* Right */}

          {note.preview ? (

            <button className="flex items-center gap-1 rounded-lg bg-orange-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-orange-600">

              <Download className="h-3.5 w-3.5" />

              Download

            </button>

          ) : (

            <button className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100">

              Unlock

            </button>

          )}

        </div>

      </div>

    ))}

    {/* Bottom CTA */}

    <div className="rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-orange-50 p-4">

      <div className="flex items-start gap-3">

        <CheckCircle2 className="mt-0.5 h-5 w-5 text-orange-600" />

        <div>

          <h4 className="text-sm font-semibold text-slate-900">
            Unlock Complete Study Pack
          </h4>

          <p className="mt-1 text-xs leading-5 text-slate-600">
            Register to access all lecture notes, revision guides,
            model papers, assignments, quizzes and future downloads.
          </p>

        </div>

      </div>

    </div>

  </div>

</div>
  );
}