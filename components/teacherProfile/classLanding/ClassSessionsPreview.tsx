"use client";

import { useState } from "react";

import {
  CheckCircle2,
  Clock3,
  Lock,
  PlayCircle,
  Video,
  X,
} from "lucide-react";

import { ClassLectureSession } from "@/types/teacherProfileTypes/ClassLectureSession";

interface Props {
  lectures: ClassLectureSession[];
}

function formatDuration(startedAt: string | null, endedAt: string | null) {
  if (!startedAt || !endedAt) return null;

  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;

  const totalMinutes = Math.round((end - start) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

export default function ClassSessionsPreview({ lectures }: Props) {
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);

  const freeCount = lectures.reduce(
    (total, lecture) =>
      total +
      lecture.recordings.filter((r) => r.access === "FREE").length,
    0
  );

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">

        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100">
            <Video className="h-4 w-4 text-emerald-600" />
          </div>

          <div>
            <h2 className="text-[16px] font-bold text-slate-900">
              Course Sessions
            </h2>
            <p className="mt-0.5 text-[14px] text-slate-500">
              Recorded lectures published for this class.
            </p>
          </div>
        </div>

        {freeCount > 0 && (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
            {freeCount} Free
          </span>
        )}

      </div>

      {/* Body */}
      <div className="space-y-3 p-5">

        {lectures.length === 0 ? (

          <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
            <Video className="mx-auto h-7 w-7 text-slate-300" />
            <p className="mt-2 text-[14px] font-medium text-slate-600">
              No sessions published yet
            </p>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Recorded lectures will appear here once the teacher publishes them.
            </p>
          </div>

        ) : (

          lectures.map((lecture) => (
            <div
              key={lecture.id}
              className="overflow-hidden rounded-lg border border-slate-200"
            >
              {/* Lecture header */}
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <PlayCircle className="h-4 w-4 shrink-0 text-emerald-600" />
                  <h3 className="truncate text-[15px] font-semibold text-slate-900">
                    {lecture.title}
                  </h3>
                </div>

                <span className="shrink-0 text-[12px] font-medium text-slate-400">
                  {lecture.recordings.length}{" "}
                  {lecture.recordings.length === 1 ? "recording" : "recordings"}
                </span>
              </div>

              {/* Recordings */}
              <div className="divide-y divide-slate-100">
                {lecture.recordings.map((recording, index) => {
                  const duration = formatDuration(
                    recording.startedAt,
                    recording.endedAt
                  );
                  const isFree = recording.access === "FREE";

                  return (
                    <div
                      key={recording.id}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span
                          className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                            isFree
                              ? "bg-emerald-100 text-emerald-600"
                              : "bg-slate-100 text-slate-400"
                          }`}
                        >
                          <PlayCircle className="h-4 w-4" />
                          {!isFree && (
                            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-slate-500 ring-2 ring-white">
                              <Lock className="h-2.5 w-2.5" />
                            </span>
                          )}
                        </span>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="text-[14px] font-medium text-slate-800">
                              {index + 1}. {lecture.title}
                            </p>

                            {isFree ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">
                                FREE
                              </span>
                            ) : (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-500">
                                LOCKED
                              </span>
                            )}
                          </div>

                          {duration && (
                            <p className="mt-0.5 flex items-center gap-1 text-[13px] text-slate-500">
                              <Clock3 className="h-3.5 w-3.5 text-orange-500" />
                              {duration}
                            </p>
                          )}
                        </div>
                      </div>

                      {isFree ? (
                        <button
                          type="button"
                          onClick={() => setPlayingVideoId(recording.videoId)}
                          className="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-emerald-700"
                        >
                          <PlayCircle className="h-3.5 w-3.5" />
                          Watch
                        </button>
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

        {/* Footer */}
        <div className="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <div>
              <h4 className="text-[14px] font-semibold text-slate-900">
                Unlock Full Course
              </h4>
              <p className="mt-0.5 text-[13px] leading-5 text-slate-600">
                Register to unlock every locked recording plus notes, assignments, quizzes and future sessions.
              </p>
            </div>
          </div>
        </div>

      </div>

      {/* YouTube player */}
      {playingVideoId && (
        <>
          <div
            className="fixed inset-0 z-[70] bg-black/70"
            onClick={() => setPlayingVideoId(null)}
            aria-hidden
          />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
            <div
              className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-200 bg-black shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-white">
                  <Video className="h-3.5 w-3.5" />
                  Lecture recording
                </p>
                <button
                  type="button"
                  onClick={() => setPlayingVideoId(null)}
                  aria-label="Close player"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="aspect-video w-full">
                <iframe
                  key={playingVideoId}
                  title="Lecture recording"
                  src={`https://www.youtube.com/embed/${playingVideoId}?autoplay=1`}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          </div>
        </>
      )}

    </div>
  );
}
