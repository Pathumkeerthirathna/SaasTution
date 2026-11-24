"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, CalendarDays, ChevronLeft, Layers, Loader2, Play, Video } from "lucide-react";

import { LockedResourceBadge } from "@/components/student-portal/locked-resource";
import { listFailureMessage } from "./player-errors";
import {
  formatDuration,
  formatLectureDateTime,
  groupByLecture,
  listApiUrl,
  mergeRecordings,
  partLabel,
  playerHref,
  recordingDateLabel,
  type RecordedLecture,
  type RecordingSection,
} from "./recording-helpers";

/*
 * One class's recorded lectures (RL-5.1; Recorded Lectures redesign Stage 3):
 *  1. General Recordings: the class's recordings that belong to no lecture
 *     (section "general": part number ascending, the same order as the General
 *     player; each with its availability date, never a lecture date);
 *  2. Lecture Recordings: lectures (newest first), each with its parts
 *     (section "lecture": exactly the previous list).
 * The first page of each comes from the server page; each section's "Load
 * more" asks the list API for ITS next page (classId + section + its own
 * cursor; a General cursor is never sent with the lecture section or the
 * reverse). A different class is a fresh client (the page keys it by class),
 * and a request still running when the page leaves is aborted. Links never
 * prefetch (each player page is a server render with database queries).
 */

const PAGE_SIZE = 50;

export type ClassRecordingsClientProps = {
  classInfo: { id: string; name: string };
  /** The class's General Recordings (first page). */
  initialGeneral?: { recordedLectures: RecordedLecture[]; nextCursor: string | null };
  /** The lecture recordings (first page). */
  initialRecordings: RecordedLecture[];
  initialNextCursor: string | null;
};

type SectionState = { recordings: RecordedLecture[]; nextCursor: string | null; loading: boolean; error: { message: string; signIn: boolean } | null };

function useSectionPages(classId: string, section: RecordingSection, initial: { recordedLectures: RecordedLecture[]; nextCursor: string | null }) {
  const [state, setState] = useState<SectionState>({ recordings: initial.recordedLectures, nextCursor: initial.nextCursor, loading: false, error: null });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function loadMore() {
    if (!state.nextCursor || state.loading) return;
    const cursor = state.nextCursor;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const response = await fetch(listApiUrl({ classId, section }, cursor, PAGE_SIZE), { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setState((prev) => ({ ...prev, loading: false, error: listFailureMessage(response.status) }));
        return;
      }
      const json = (await response.json()) as { data?: { recordedLectures?: RecordedLecture[]; nextCursor?: string | null } };
      if (controller.signal.aborted) return;
      setState((prev) => ({
        recordings: mergeRecordings(prev.recordings, json.data?.recordedLectures ?? []),
        nextCursor: json.data?.nextCursor ?? null,
        loading: false,
        error: null,
      }));
    } catch {
      if (!controller.signal.aborted) setState((prev) => ({ ...prev, loading: false, error: listFailureMessage(0) }));
    }
  }

  return { ...state, loadMore };
}

function LoadMore({ section, label }: { section: ReturnType<typeof useSectionPages>; label: string }) {
  if (!section.nextCursor) return null;
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => void section.loadMore()}
        disabled={section.loading}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-4 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-60"
      >
        {section.loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
        {label}
      </button>
      {section.error ? (
        <p role="alert" className="text-center text-xs text-rose-700">
          {section.error.message}{" "}
          {section.error.signIn ? (
            <Link href="/login" className="font-semibold underline">
              Sign in
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function PartRow({ part, lectureId, classId, dateLine }: { part: RecordedLecture; lectureId: string; classId: string; dateLine: string }) {
  if (part.resourceAccess?.locked) {
    return (
      <div className="flex min-h-[44px] items-start gap-2.5 bg-amber-50/50 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block break-words text-xs font-semibold text-slate-800">
            {partLabel(part)} · {part.title}
          </span>
          <span className="mt-1 block">
            <LockedResourceBadge lock={part.resourceAccess} classId={classId} />
          </span>
        </span>
      </div>
    );
  }
  return (
    <Link href={playerHref(lectureId, part.id)} prefetch={false} className="flex min-h-[44px] items-start gap-2.5 px-3 py-2 hover:bg-emerald-50/60">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <Play size={12} className="translate-x-[1px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-xs font-semibold text-slate-800">
          {partLabel(part)} · {part.title}
        </span>
        <span className="block text-[11px] text-slate-500">
          {formatDuration(part.durationSeconds)}
          {dateLine ? ` · ${dateLine}` : ""}
        </span>
      </span>
    </Link>
  );
}

export function ClassRecordingsClient({ classInfo, initialGeneral, initialRecordings, initialNextCursor }: ClassRecordingsClientProps) {
  const general = useSectionPages(classInfo.id, "general", initialGeneral ?? { recordedLectures: [], nextCursor: null });
  const lectures = useSectionPages(classInfo.id, "lecture", { recordedLectures: initialRecordings, nextCursor: initialNextCursor });

  const groups = useMemo(() => groupByLecture(lectures.recordings), [lectures.recordings]);
  // Every General Recording plays from the class's General Recordings (one player for all of them).
  const generalPlayerId = general.recordings[0]?.lecture.id ?? null;

  return (
    <div className="space-y-4">
      <Link
        href="/student/recorded-lectures"
        className="inline-flex min-h-[44px] items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-900"
      >
        <ChevronLeft size={14} aria-hidden />
        All classes
      </Link>

      {/* 1. General Recordings */}
      <section aria-labelledby="general-recordings-heading" className="space-y-2" data-recordings-section="general">
        <h2 id="general-recordings-heading" className="flex items-center gap-1.5 text-sm font-bold text-slate-900">
          <BookOpen size={15} className="text-emerald-700" aria-hidden />
          General Recordings
        </h2>
        {general.recordings.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs text-slate-500" data-recordings-empty="general">
            No general recordings for {classInfo.name} yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-sm">
            <ol className="divide-y divide-slate-100">
              {general.recordings.map((part) => (
                <li key={part.id}>
                  <PartRow part={part} lectureId={part.lecture.id} classId={classInfo.id} dateLine={recordingDateLabel(part)} />
                </li>
              ))}
            </ol>
            {generalPlayerId ? (
              <Link
                href={playerHref(generalPlayerId)}
                prefetch={false}
                className="flex min-h-[44px] items-center justify-center gap-1.5 border-t border-slate-100 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
              >
                <Play size={13} aria-hidden />
                Watch general recordings
              </Link>
            ) : null}
          </div>
        )}
        <LoadMore section={general} label="Load more general recordings" />
      </section>

      {/* 2. Lecture Recordings */}
      <section aria-labelledby="lecture-recordings-heading" className="space-y-2" data-recordings-section="lecture">
        <h2 id="lecture-recordings-heading" className="flex items-center gap-1.5 text-sm font-bold text-slate-900">
          <Layers size={15} className="text-brand-700" aria-hidden />
          Lecture Recordings
        </h2>
        {groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center" data-recordings-empty="lecture">
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
                      <PartRow part={part} lectureId={group.lecture.id} classId={classInfo.id} dateLine="" />
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
        <LoadMore section={lectures} label="Load more recordings" />
      </section>
    </div>
  );
}
