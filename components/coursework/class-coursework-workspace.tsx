"use client";

/*
 * The standalone teacher Assignments and Quizzes pages (one page each): a
 * class, then optionally one of its NORMAL lectures.
 *  - No lecture: the class's General Assignments / General Quizzes (its
 *    default lecture, resolved by the class API on the server; its id is
 *    never sent from here).
 *  - A lecture: that lecture's assignments / quizzes.
 * The section is managed by the EXISTING panels (LectureAssignmentPanel /
 * LectureQuizPanel) in their `scope` mode: listing and creation through
 * /api/classes/[id]/assignments|quizzes[?lectureId=], everything else through
 * the existing per-item routes. The panel is keyed by the selection, so a
 * previous class's or lecture's response can never show in the current one.
 * The lecture selector lists normal lectures only (GET /api/lectures?classId=).
 * The selection is kept in the address (?classId=&lectureId=), checked on the
 * server when the page is opened (lib/teacher-class-lecture-selection.ts).
 */

import { useEffect, useState } from "react";
import { BookOpen, ClipboardList, FileQuestion } from "lucide-react";

import { normalLectureLabel, useNormalLectures } from "@/components/class-selection/use-normal-lectures";
import { LectureAssignmentPanel } from "@/components/lecture-assignment-panel";
import { LectureQuizPanel } from "@/components/lecture-quiz-panel";
import type { ClassContentKind } from "@/lib/class-content-scope";
import { GENERAL_ASSIGNMENTS_LABEL, GENERAL_QUIZZES_LABEL } from "@/lib/coursework-lecture";

export type CourseworkClass = { id: string; name: string };

export const COURSEWORK_TEXT: Record<ClassContentKind, { title: string; description: string; general: string; generalHint: string; noun: string }> = {
  assignments: {
    title: "Assignments",
    description: "Create and grade assignments for a whole class (General Assignments) or for one of its lectures.",
    general: GENERAL_ASSIGNMENTS_LABEL,
    generalHint: "Assignments for the whole class, not tied to a lecture.",
    noun: "assignments",
  },
  quizzes: {
    title: "Quizzes",
    description: "Create quizzes and see results for a whole class (General Quizzes) or for one of its lectures.",
    general: GENERAL_QUIZZES_LABEL,
    generalHint: "Quizzes for the whole class, not tied to a lecture.",
    noun: "quizzes",
  },
};

/** The page address for a selection (kept in the URL so a reload or a shared link reopens it). */
export function courseworkSelectionQuery(classId: string, lectureId: string): string {
  const query = new URLSearchParams();
  if (classId) query.set("classId", classId);
  if (classId && lectureId) query.set("lectureId", lectureId);
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function ClassCourseworkWorkspace({
  kind,
  classes,
  initialClassId = null,
  initialLectureId = null,
}: {
  kind: ClassContentKind;
  classes: CourseworkClass[];
  initialClassId?: string | null;
  initialLectureId?: string | null;
}) {
  const text = COURSEWORK_TEXT[kind];
  const [classId, setClassId] = useState(initialClassId ?? "");
  const [lectureId, setLectureId] = useState(initialClassId ? initialLectureId ?? "" : "");
  const { lectures, loadOlder, retry } = useNormalLectures(classId || null);

  // Keep the selection in the address bar (no navigation, no history entry per change).
  useEffect(() => {
    const next = `${window.location.pathname}${courseworkSelectionQuery(classId, lectureId)}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [classId, lectureId]);

  function chooseClass(next: string) {
    setClassId(next);
    setLectureId("");
  }

  const selectedLecture = lectureId && lectures?.state === "ready" ? lectures.items.find((l) => l.id === lectureId) ?? null : null;
  const sectionTitle = lectureId ? (selectedLecture ? normalLectureLabel(selectedLecture) : "Lecture") : text.general;
  const scopeKey = `${classId}:${lectureId || "general"}`;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-coursework-workspace={kind}>
      <section aria-labelledby="coursework-page-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex min-w-0 items-center gap-3 border-b border-slate-200 p-3 sm:px-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#32598A] text-white">
            {kind === "assignments" ? <ClipboardList size={18} aria-hidden /> : <FileQuestion size={18} aria-hidden />}
          </span>
          <div className="min-w-0">
            <h1 id="coursework-page-heading" className="text-xl font-semibold tracking-tight text-slate-900">
              {text.title}
            </h1>
            <p className="break-words text-[12px] text-slate-500 sm:text-[13px]">{text.description}</p>
          </div>
        </header>

        {classes.length === 0 ? (
          <p className="m-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600 sm:mx-4" data-coursework-empty="classes">
            You have no classes yet. Create a class first.
          </p>
        ) : (
          <div className="grid gap-2 p-3 sm:grid-cols-2 sm:px-4">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
              Class
              <select value={classId} onChange={(event) => chooseClass(event.target.value)} className="control-select h-10 w-full min-w-0 text-sm" data-coursework-class-select>
                <option value="">Select a class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-600">
              Lecture (optional)
              <select
                value={lectureId}
                onChange={(event) => setLectureId(event.target.value)}
                disabled={!classId}
                className="control-select h-10 w-full min-w-0 text-sm"
                data-coursework-lecture-select
              >
                <option value="">{classId ? `${text.general} (no lecture)` : "Select a class first"}</option>
                {lectures?.state === "ready"
                  ? lectures.items.map((l) => (
                      <option key={l.id} value={l.id}>
                        {normalLectureLabel(l)}
                      </option>
                    ))
                  : null}
                {/* A lecture from the address, shown until the list arrives (it was checked on the server). */}
                {lectureId && lectures?.state !== "ready" ? <option value={lectureId}>Selected lecture</option> : null}
              </select>
              {lectures?.state === "loading" ? (
                <span className="text-[11px] font-normal text-slate-500" data-coursework-lectures="loading">
                  Loading lectures…
                </span>
              ) : null}
              {lectures?.state === "ready" && lectures.items.length === 0 ? (
                <span className="text-[11px] font-normal text-slate-500" data-coursework-lectures="none">
                  This class has no lectures yet.
                </span>
              ) : null}
              {lectures?.state === "ready" && lectures.hasNextPage ? (
                <button type="button" onClick={loadOlder} className="self-start text-xs font-semibold text-brand-700 hover:underline">
                  Load older lectures
                </button>
              ) : null}
            </label>
            {lectures?.state === "error" ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 sm:col-span-2">
                <span>{lectures.message}</span>
                <button type="button" onClick={retry} className="rounded-md border border-rose-200 bg-white px-2 py-1 font-semibold">
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {classId ? (
        <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4" data-coursework-section={lectureId ? "LECTURE" : "GENERAL"} data-coursework-scope={scopeKey}>
          <div className="mb-3 min-w-0">
            <h2 className="break-words text-base font-semibold text-slate-900">{sectionTitle}</h2>
            <p className="text-[12px] text-slate-500">{lectureId ? `The ${text.noun} of this lecture.` : text.generalHint}</p>
          </div>
          {kind === "assignments" ? (
            <LectureAssignmentPanel key={scopeKey} scope={{ classId, lectureId: lectureId || null }} />
          ) : (
            <LectureQuizPanel key={scopeKey} scope={{ classId, lectureId: lectureId || null }} />
          )}
        </section>
      ) : classes.length > 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-coursework-empty="no-class">
          <BookOpen size={15} className="shrink-0 text-slate-400" aria-hidden />
          Select a class to manage its {text.noun}.
        </p>
      ) : null}
    </div>
  );
}
