"use client";

import {
  CheckCircle2,
  Clock3,
  Lock,
  PlayCircle,
  Video,
} from "lucide-react";

import { ClassSession } from "../../../types/teacherProfileTypes/ClassSession";

interface Props {
  sessions: ClassSession[];
}

export default function ClassSessionsPreview({
  sessions,
}: Props) {
  const previewCount = sessions.filter(
    (x) => x.preview
  ).length;

  return (
 <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

  {/* Header */}

  <div className="border-b border-slate-100 bg-gradient-to-r from-emerald-50 via-white to-orange-50 px-5 py-4">

    <div className="flex items-center justify-between">

      <div>

        <h2 className="text-lg font-bold text-slate-900">
          Course Sessions
        </h2>

        <p className="mt-0.5 text-xs text-slate-500">
          Preview lessons available before registration.
        </p>

      </div>

      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
        {previewCount} Free Lessons
      </span>

    </div>

  </div>

  {/* Body */}

  <div className="space-y-3 p-5">

    {sessions.map((session) => (

      <div
        key={session.id}
        className={`rounded-xl border transition hover:border-emerald-200 hover:shadow-sm ${
          session.preview
            ? "border-emerald-100 bg-emerald-50/40"
            : "border-slate-200 bg-slate-50"
        }`}
      >

        <div className="flex items-center justify-between gap-4 p-4">

          {/* Left */}

          <div className="flex items-start gap-3 flex-1">

            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                session.preview
                  ? "bg-emerald-100"
                  : "bg-slate-200"
              }`}
            >
              {session.preview ? (
                <PlayCircle className="h-5 w-5 text-emerald-600" />
              ) : (
                <Lock className="h-5 w-5 text-slate-500" />
              )}
            </div>

            <div className="min-w-0 flex-1">

              <div className="flex flex-wrap items-center gap-2">

                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                  Lesson {session.lessonNo}
                </span>

                {session.preview && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    FREE
                  </span>
                )}

              </div>

              <h3 className="mt-2 text-base font-semibold text-slate-900">
                {session.title}
              </h3>

              <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-600">
                {session.description}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">

                <div className="flex items-center gap-1">
                  <Clock3 className="h-3.5 w-3.5 text-orange-500" />
                  {session.duration}
                </div>

                <div className="flex items-center gap-1">
                  <Video className="h-3.5 w-3.5 text-emerald-600" />
                  HD Video
                </div>

              </div>

            </div>

          </div>

          {/* Right */}

          {session.preview ? (

            <button className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700">
              Watch
            </button>

          ) : (

            <button className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-xs font-semibold text-orange-700 transition hover:bg-orange-100">
              Unlock
            </button>

          )}

        </div>

      </div>

    ))}

    {/* Footer */}

    <div className="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-4">

      <div className="flex items-start gap-3">

        <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />

        <div>

          <h4 className="text-sm font-semibold text-slate-900">
            Unlock Full Course
          </h4>

          <p className="mt-1 text-xs leading-5 text-slate-600">
            Register to access all sessions, downloadable notes,
            assignments, quizzes and future recordings.
          </p>

        </div>

      </div>

    </div>

  </div>

</div>
  );
}