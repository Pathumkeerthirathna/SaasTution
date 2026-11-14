"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, Loader2, Play, Video } from "lucide-react";

import { listFailureMessage } from "./player-errors";
import {
  formatDuration,
  formatLectureDateTime,
  groupByLecture,
  listApiUrl,
  mergeRecordings,
  partLabel,
  playerHref,
  type RecordedLecture,
} from "./recording-helpers";

/*
 * One class's recorded lectures (RL-5.1): lectures (newest first), each with
 * its parts. The first page comes from the server page; "Load more" asks the
 * list API for the next page (classId + cursor). Parts of a lecture that is
 * split over two pages are merged into one card. Links never prefetch (each
 * player page is a server render with database queries).
 */

const PAGE_SIZE = 50;

export type ClassRecordingsClientProps = {
  classInfo: { id: string; name: string };
  initialRecordings: RecordedLecture[];
  initialNextCursor: string | null;
};

export function ClassRecordingsClient({ classInfo, initialRecordings, initialNextCursor }: ClassRecordingsClientProps) {
  const [recordings, setRecordings] = useState<RecordedLecture[]>(initialRecordings);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; signIn: boolean } | null>(null);

  const groups = useMemo(() => groupByLecture(recordings), [recordings]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(listApiUrl({ classId: classInfo.id }, nextCursor, PAGE_SIZE), { cache: "no-store" });
      if (!response.ok) {
        setError(listFailureMessage(response.status));
        return;
      }
      const json = (await response.json()) as { data?: { recordedLectures?: RecordedLecture[]; nextCursor?: string | null } };
      setRecordings((prev) => mergeRecordings(prev, json.data?.recordedLectures ?? []));
      setNextCursor(json.data?.nextCursor ?? null);
    } catch {
      setError(listFailureMessage(0));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <Link
        href="/student/recorded-lectures"
        className="inline-flex min-h-[44px] items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-900"
      >
        <ChevronLeft size={14} aria-hidden />
        All classes
      </Link>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center">
          <Video size={22} className="mx-auto text-slate-400" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-slate-700">No recorded lectures yet</p>
          <p className="mt-1 text-xs text-slate-500">Recordings your teacher uploads for {classInfo.name} will appear here.</p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <li key={group.lecture.id} className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="space-y-1 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-2.5">
                <h3 className="break-words text-sm font-bold text-slate-900">{group.lecture.title}</h3>
                <p className="flex items-center gap-1 text-[11px] text-slate-500">
                  <CalendarDays size={11} aria-hidden />
                  {formatLectureDateTime(group.lecture.date)}
                </p>
              </div>
              <ol className="flex-1 divide-y divide-slate-100">
                {group.parts.map((part) => (
                  <li key={part.id}>
                    <Link
                      href={playerHref(group.lecture.id, part.id)}
                      prefetch={false}
                      className="flex min-h-[44px] items-start gap-2.5 px-3 py-2 hover:bg-emerald-50/60"
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                        <Play size={12} className="translate-x-[1px]" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-xs font-semibold text-slate-800">
                          {partLabel(part)} · {part.title}
                        </span>
                        <span className="block text-[11px] text-slate-500">{formatDuration(part.durationSeconds)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
              <Link
                href={playerHref(group.lecture.id)}
                prefetch={false}
                className="flex min-h-[44px] items-center justify-center gap-1.5 border-t border-slate-100 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
              >
                <Play size={13} aria-hidden />
                Watch lecture
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-4 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            Load more recordings
          </button>
          {error ? (
            <p role="alert" className="text-center text-xs text-rose-700">
              {error.message}{" "}
              {error.signIn ? (
                <Link href="/login" className="font-semibold underline">
                  Sign in
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
