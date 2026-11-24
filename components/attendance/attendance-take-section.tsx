"use client";

/*
 * The Attendance workspace on the teacher's Attendance page, above the
 * existing Upcoming / Previous lecture list (which is unchanged).
 *
 *  - ONE card: the page heading (Attendance and its description) above a
 *    divider, then the title "<class> — <month>", the selected lecture
 *    (or "No lecture selected"), month navigation (Previous / the month /
 *    Next, always visible), Change, and the accordion it expands inline (no
 *    popover) with the Class and Lecture selectors, Open QR Scanner and Done.
 *    Collapsed on load; collapsed again when a lecture is chosen; opening or
 *    closing it never clears a selection or loads data (the region stays
 *    mounted, only hidden). In overview mode the month's matrix is part of
 *    the same card (below a divider; no second card); with a lecture
 *    selected, its register follows the card as its own section.
 *  - Class: the first of the teacher's classes (the existing, ownership-
 *    checked class list, in its order) is selected once the list has loaded;
 *    none when the teacher has no class (empty state, nothing loaded).
 *  - Month: one Sri Lankan (Asia/Colombo) calendar month, the current one
 *    on load (computed once by the server page: the same value for the server
 *    render and the hydration), with Previous / Next month (plain month
 *    arithmetic, December ↔ January included; never the browser's time zone).
 *    Changing the month clears the selected lecture first (a register of
 *    another month is never shown) and keeps the class.
 *  - Lecture: only the selected class's lectures in the selected month, from
 *    the existing lecture list (GET /api/lectures with the month's Colombo
 *    bounds as from / to, oldest first, 100 per page with "Load more").
 *    Changing the class clears the lecture. Cancelled lectures are listed but
 *    cannot be chosen.
 *  - Open QR Scanner: with a lecture, the existing scanner modal on this page
 *    (qr-scanner-modal.tsx; no navigation); without, the lecture creation
 *    dialog (attendance-lecture-dialog.tsx), after which the lecture is
 *    selected (its month shown when it differs) and the scanner opens for it.
 *    Nothing is ever created on load or on selection.
 *  - Below, ONE of two modes:
 *      overview (no lecture selected): the class attendance matrix of the
 *      month (GET /api/classes/[id]/attendance-matrix), directly under the
 *      card (the card already names the class and month); a reload of the
 *      same month keeps it shown until the new one arrives;
 *      register (a lecture selected): only that lecture's register, the
 *      existing LectureAttendanceRegisterPanel (variant="embedded"; every
 *      register feature), keyed by the lecture. The matrix is not fetched in
 *      this mode; it is reloaded when the overview returns.
 *    Closing the scanner reloads the register (refreshKey), or the matrix in
 *    overview mode.
 * Only the newest request may update the page (older ones are aborted).
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, QrCode, RefreshCw, Table2 } from "lucide-react";

import {
  fetchClassAttendanceMatrix,
  fetchClassLectures,
  formatColomboDateTime,
  type AttendanceApiError,
  type AttendanceMatrix,
  type ClassLectureOption,
} from "@/components/attendance/attendance-ui";
import { AttendanceLectureDialog, TAKE_ATTENDANCE_BUTTON_ID, type ExistingLecture } from "@/components/attendance/attendance-lecture-dialog";
import { AttendanceMatrixTable, MatrixLegend, monthLabel } from "@/components/attendance/attendance-matrix";
import { AttendancePageHeading } from "@/components/attendance/attendance-page-heading";
import { colomboMonthBounds, colomboMonthKey, isMonthKey, shiftMonthKey } from "@/components/attendance/attendance-month";
import { QrScannerModal } from "@/components/attendance/qr-scanner-modal";

export { colomboMonthBounds, colomboMonthKey, shiftMonthKey };

/** The existing register, loaded with the section only when a lecture is selected. */
const LectureAttendanceRegisterPanel = dynamic(
  () => import("@/components/attendance/lecture-attendance-register-panel").then((mod) => mod.LectureAttendanceRegisterPanel),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <Loader2 size={14} className="animate-spin text-[#112D5C]" aria-hidden />
        Loading the attendance register…
      </p>
    ),
  }
);

export const LECTURE_ATTENDANCE_HEADING_ID = "lecture-attendance-heading";
export const MONTHLY_OVERVIEW_HEADING_ID = "monthly-overview-heading";
export const SELECTION_REGION_ID = "attendance-selection-region";

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

/** The Sri Lankan month "YYYY-MM" of a lecture's start (UTC ISO); null when invalid. */
export function lectureMonthKey(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : colomboMonthKey(new Date(ms));
}

export type ScannerAction = { kind: "DISABLED" } | { kind: "OPEN_SCANNER"; lectureId: string } | { kind: "CREATE_LECTURE" };

/** What "Open QR Scanner" does: nothing without a class; the scanner modal for a chosen lecture; otherwise the creation dialog. */
export function scannerAction(classId: string, lectureId: string): ScannerAction {
  if (!classId) return { kind: "DISABLED" };
  if (lectureId) return { kind: "OPEN_SCANNER", lectureId };
  return { kind: "CREATE_LECTURE" };
}

/**
 * The selector's lectures with `lecture` in them (a newly created one is not
 * in the loaded page yet), oldest first like the month's list, never twice.
 */
export function withLectureOption(lectures: readonly ClassLectureOption[], lecture: ExistingLecture): ClassLectureOption[] {
  if (lectures.some((l) => l.id === lecture.id)) return [...lectures];
  const option: ClassLectureOption = { id: lecture.id, title: lecture.title, date: lecture.date, endDate: lecture.endDate, classStatus: "SCHEDULED" };
  return [...lectures, option].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The open scanner modal: its lecture, and the opening number (a fresh panel and camera controller each time). */
export type ScannerModalState = { lectureId: string; opening: number } | null;

/** The selector's label for a lecture (Sri Lankan time). */
export function lectureOptionLabel(lecture: ClassLectureOption): string {
  return `${formatColomboDateTime(lecture.date)} · ${lecture.title}${lecture.classStatus === "CANCELLED" ? " (cancelled)" : ""}`;
}

export type LectureLoad = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

/** The selector's first ("no lecture") option. */
export function noLectureOptionLabel(input: { classId: string; lectureLoad: LectureLoad; lectureCount: number }): string {
  if (!input.classId) return "Select a class first";
  if (input.lectureLoad.kind === "loading" && input.lectureCount === 0) return "Loading this month's lectures…";
  if (input.lectureLoad.kind === "ready" && input.lectureCount === 0) return "No lectures in this month";
  return "No lecture selected (monthly overview)";
}

export type WorkspaceMode = "NO_CLASS" | "OVERVIEW" | "REGISTER";

/** What is shown under the selectors: the register only for a selected lecture; otherwise the month's matrix. */
export function workspaceMode(classId: string, lectureId: string): WorkspaceMode {
  if (!classId) return "NO_CLASS";
  return lectureId ? "REGISTER" : "OVERVIEW";
}

/**
 * The class to select once the teacher's class list has loaded: the first
 * one, in the list's own order (the API returns only the teacher's classes);
 * none while loading, when the list failed (null) or is empty.
 */
export function firstClassId(classOptions: readonly { id: string }[] | null, loaded: boolean): string {
  if (!loaded || !classOptions || classOptions.length === 0) return "";
  return classOptions[0].id;
}

/** The control card's title: "<class> — <month>" (the month alone without a class). */
export function classMonthTitle(className: string, month: string): string {
  return className ? `${className} — ${monthLabel(month)}` : monthLabel(month);
}

/** The control card's lecture line: the selected lecture and its start, or the overview. */
export function lectureSummary(lecture: ClassLectureOption | null): string {
  return lecture ? `Lecture: ${lecture.title} · ${formatColomboDateTime(lecture.date)}` : "No lecture selected · monthly overview";
}

type MatrixLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: AttendanceApiError }
  /** refreshing: a reload of the shown month is running (the matrix stays shown). */
  | { kind: "ready"; matrix: AttendanceMatrix; refreshing?: boolean };

/**
 * The matrix state while a request for (classId, month) runs: the shown
 * matrix stays (marked refreshing) when it is that class and that month (or
 * the current month, month null); otherwise loading.
 */
export function matrixLoadingState(previous: MatrixLoad, classId: string, month: string | null): MatrixLoad {
  if (previous.kind === "ready" && previous.matrix.class.id === classId && (month === null || previous.matrix.month.key === month)) {
    return { kind: "ready", matrix: previous.matrix, refreshing: true };
  }
  return { kind: "loading" };
}

const SECONDARY_BUTTON =
  "inline-flex h-[38px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-700 hover:border-[#8fb0cd] hover:bg-[#eef3f8] hover:text-[#264867]";

/** A month step inside the segmented month control (icon + text; text from sm). */
const MONTH_STEP_BUTTON =
  "inline-flex h-[38px] items-center gap-1 rounded-md px-2.5 text-[13px] font-medium text-slate-700 hover:bg-[#eef3f8] hover:text-[#264867]";

// =========================================================================================
// The workspace
// =========================================================================================

export function AttendanceTakeSection({
  classOptions,
  classesLoaded = true,
  initialMonth,
  now,
}: {
  /** The teacher's classes (null: the list could not be loaded). */
  classOptions: { id: string; name: string }[] | null;
  /** The class list has finished loading (the first class is selected then). */
  classesLoaded?: boolean;
  /** The current Sri Lankan month, computed once by the server page (no hydration mismatch). */
  initialMonth?: string;
  /** Tests: the clock used when no initial month is given. */
  now?: () => Date;
}) {
  const [classId, setClassId] = useState("");
  const [lectureId, setLectureId] = useState("");
  const [month, setMonth] = useState<string>(() => (isMonthKey(initialMonth) ? initialMonth : colomboMonthKey(now ? now() : new Date())));
  const [lectures, setLectures] = useState<ClassLectureOption[]>([]);
  const [lecturePage, setLecturePage] = useState(1);
  const [hasMoreLectures, setHasMoreLectures] = useState(false);
  const [lectureLoad, setLectureLoad] = useState<LectureLoad>({ kind: "idle" });
  const [matrixLoad, setMatrixLoad] = useState<MatrixLoad>({ kind: "idle" });
  const [matrixAttempt, setMatrixAttempt] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scanner, setScanner] = useState<ScannerModalState>(null);
  /** Asks the embedded register to reload (after the scanner modal closes). */
  const [registerRefresh, setRegisterRefresh] = useState(0);
  /** The selector accordion (display only: never loads data or clears a selection). */
  const [expanded, setExpanded] = useState(false);
  const autoSelected = useRef(false);
  const regionId = useId();

  const className = classOptions?.find((option) => option.id === classId)?.name ?? "";
  const mode = workspaceMode(classId, lectureId);
  const overview = mode === "OVERVIEW";
  const noClasses = classesLoaded && Array.isArray(classOptions) && classOptions.length === 0;

  // The first class, once the teacher's class list has loaded (never again: the teacher's choice stays).
  useEffect(() => {
    if (autoSelected.current || classId) return;
    const first = firstClassId(classOptions, classesLoaded);
    if (!first) return;
    autoSelected.current = true;
    setClassId(first);
  }, [classOptions, classesLoaded, classId]);

  // The selected class's lectures in the selected month (pages appended; a class or month change starts again).
  useEffect(() => {
    if (!classId) return;
    const controller = new AbortController();
    setLectureLoad({ kind: "loading" });
    void fetchClassLectures(classId, colomboMonthBounds(month), lecturePage, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setLectureLoad({ kind: "error", message: result.message });
        return;
      }
      setLectures((previous) => {
        const merged = lecturePage === 1 ? result.data : [...previous, ...result.data];
        // Never twice (a lecture added locally after its creation may also come from the server).
        return merged.filter((lecture, index) => merged.findIndex((l) => l.id === lecture.id) === index);
      });
      setHasMoreLectures(result.pagination?.hasNextPage ?? false);
      setLectureLoad({ kind: "ready" });
    });
    return () => controller.abort();
  }, [classId, month, lecturePage]);

  // The month's matrix: only in overview mode (no register shown). Returning to the overview reloads it.
  useEffect(() => {
    if (!classId || !overview) return;
    const controller = new AbortController();
    setMatrixLoad((previous) => matrixLoadingState(previous, classId, month));
    void fetchClassAttendanceMatrix(classId, month, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setMatrixLoad(result.ok ? { kind: "ready", matrix: result.data } : { kind: "error", error: result });
    });
    return () => controller.abort();
  }, [classId, month, matrixAttempt, overview]);

  /** A new month or class: the lecture selection and the month's lecture list start again. */
  const resetLectures = useCallback(() => {
    setLectureId(""); // never a register of another class or month
    setLectures([]);
    setLecturePage(1);
    setHasMoreLectures(false);
    setLectureLoad({ kind: "idle" });
    setDialogOpen(false);
    setScanner(null);
  }, []);

  const changeClass = useCallback(
    (next: string) => {
      resetLectures();
      setClassId(next);
      setMatrixLoad({ kind: "idle" });
    },
    [resetLectures]
  );

  const changeMonth = useCallback(
    (delta: 1 | -1) => {
      resetLectures();
      setMonth((current) => shiftMonthKey(current, delta));
    },
    [resetLectures]
  );

  /** Choosing a lecture opens its register and folds the selectors away; clearing it returns to the overview. */
  const changeLecture = useCallback((next: string) => {
    setLectureId(next);
    if (next) setExpanded(false);
  }, []);

  /** Opens the scanner modal for a lecture (no navigation). */
  const openScannerModal = useCallback((id: string) => {
    setScanner((previous) => ({ lectureId: id, opening: (previous?.opening ?? 0) + 1 }));
  }, []);

  /**
   * After the creation dialog: the lecture is selected (register mode) and
   * the scanner opens for it. In the shown month it joins the selector; in
   * another month (the dialog's date), that month is shown instead and its
   * list (which contains the lecture) is loaded.
   */
  const lectureReady = useCallback(
    (lecture: ExistingLecture) => {
      setDialogOpen(false);
      const key = lectureMonthKey(lecture.date);
      if (key && key !== month) {
        setMonth(key);
        setLecturePage(1);
        setHasMoreLectures(false);
        setLectures(withLectureOption([], lecture));
      } else {
        setLectures((previous) => withLectureOption(previous, lecture));
      }
      setLectureId(lecture.id);
      setExpanded(false);
      openScannerModal(lecture.id);
    },
    [month, openScannerModal]
  );

  /** The matrix reloads (the same month; it stays shown meanwhile). */
  const reloadMatrix = useCallback(() => setMatrixAttempt((n) => n + 1), []);

  /** Closing the scanner: the class, month and lecture stay; the shown data reloads (new scans). */
  const closeScanner = useCallback(() => {
    setScanner(null);
    if (lectureId) setRegisterRefresh((n) => n + 1);
    else reloadMatrix();
  }, [lectureId, reloadMatrix]);

  const openSelectedScanner = useCallback(() => {
    if (lectureId) openScannerModal(lectureId);
  }, [lectureId, openScannerModal]);

  const action = scannerAction(classId, lectureId);
  const openScanner = () => {
    if (action.kind === "OPEN_SCANNER") openScannerModal(action.lectureId);
    else if (action.kind === "CREATE_LECTURE") setDialogOpen(true);
  };

  const matrix = matrixLoad.kind === "ready" && matrixLoad.matrix.class.id === classId ? matrixLoad.matrix : null;
  const selectedLecture = lectures.find((l) => l.id === lectureId) ?? null;
  /** What the card says when no class is selected (yet). */
  const classStatus = noClasses ? "No classes yet" : classOptions === null ? "Classes unavailable" : classesLoaded ? "No class selected" : "Loading your classes…";
  const title = className ? classMonthTitle(className, month) : `${classStatus} — ${monthLabel(month)}`;

  return (
    <>
      {/* The one control card: class and month, the lecture, month navigation, Change and the selectors. */}
      <section aria-labelledby="take-attendance-heading" className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm" data-selection-bar>
        {/* The page heading, at the top of the one card (no separate heading card). */}
        <div className="border-b border-slate-200 p-3 sm:px-4" data-page-heading-row>
          <AttendancePageHeading />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">
          <div className="min-w-0 flex-1">
            <h2 id="take-attendance-heading" className="break-words text-[16px] font-semibold leading-snug text-slate-900" data-class-month={month}>
              {title}
            </h2>
            <p className="mt-0.5 break-words text-[12px] text-slate-500" aria-live="polite" data-lecture-summary>
              {lectureSummary(selectedLecture)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Month" className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5" data-month-nav>
              <button type="button" onClick={() => changeMonth(-1)} aria-label="Previous month" className={MONTH_STEP_BUTTON}>
                <ChevronLeft size={14} aria-hidden />
                <span className="hidden sm:inline">Previous</span>
              </button>
              <span className="min-w-[7.5rem] px-1 text-center text-[13px] font-semibold text-slate-900" data-month={month}>
                {monthLabel(month)}
              </span>
              <button type="button" onClick={() => changeMonth(1)} aria-label="Next month" className={MONTH_STEP_BUTTON}>
                <span className="hidden sm:inline">Next</span>
                <ChevronRight size={14} aria-hidden />
              </button>
            </nav>
            {lectureId ? (
              <button type="button" onClick={() => setLectureId("")} className={SECONDARY_BUTTON}>
                <Table2 size={13} aria-hidden />
                Monthly overview
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-controls={regionId}
              disabled={noClasses || classOptions === null}
              className="inline-flex h-[38px] items-center gap-1 rounded-lg border border-[#112D5C] bg-white px-3 text-[13px] font-semibold text-[#112D5C] hover:bg-[#eef3f8] disabled:cursor-not-allowed disabled:opacity-50"
              data-selection-toggle
            >
              {expanded ? "Close" : "Change"}
              <ChevronDown size={14} aria-hidden className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
            </button>
          </div>
        </div>

        {/* The selectors, inline in the same card (an accordion, not a popover). Always mounted: opening / closing loads nothing. */}
        <div
          id={regionId}
          role="region"
          aria-label="Choose class and lecture"
          className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${expanded ? "grid-rows-[1fr]" : "invisible grid-rows-[0fr]"}`}
          data-selection-region={expanded ? "open" : "closed"}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2 border-t border-slate-100 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] font-medium text-slate-600">
                  Class
                  <select
                    value={classId}
                    onChange={(event) => changeClass(event.target.value)}
                    disabled={classOptions === null || noClasses}
                    className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-normal text-slate-900 focus:border-[#32598A] focus:outline-none focus:ring-2 focus:ring-[#32598A]/20 disabled:bg-slate-50 disabled:opacity-60"
                  >
                    {!classId ? <option value="">{classesLoaded ? "Select a class" : "Loading your classes…"}</option> : null}
                    {(classOptions ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] font-medium text-slate-600">
                  {`Lecture in ${monthLabel(month)} (optional)`}
                  <select
                    value={lectureId}
                    onChange={(event) => changeLecture(event.target.value)}
                    disabled={!classId}
                    className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-normal text-slate-900 focus:border-[#32598A] focus:outline-none focus:ring-2 focus:ring-[#32598A]/20 disabled:bg-slate-50 disabled:opacity-60"
                  >
                    <option value="">{noLectureOptionLabel({ classId, lectureLoad, lectureCount: lectures.length })}</option>
                    {lectures.map((lecture) => (
                      <option key={lecture.id} value={lecture.id} disabled={lecture.classStatus === "CANCELLED"}>
                        {lectureOptionLabel(lecture)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    id={TAKE_ATTENDANCE_BUTTON_ID}
                    onClick={openScanner}
                    // Creating waits for the class's schedules (they come with the matrix).
                    disabled={action.kind === "DISABLED" || (action.kind === "CREATE_LECTURE" && matrixLoad.kind === "loading")}
                    className="inline-flex h-10 min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-[#112D5C] px-4 text-[13px] font-semibold text-white shadow-sm hover:bg-[#0c2247] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <QrCode size={15} aria-hidden />
                    Open QR Scanner
                  </button>
                  <button type="button" onClick={() => setExpanded(false)} className={`${SECONDARY_BUTTON} h-10`}>
                    <Check size={14} aria-hidden />
                    Done
                  </button>
                </div>
              </div>
              {classId && !lectureId ? (
                <p className="text-xs leading-snug text-slate-600">
                  No lecture selected: the month&apos;s attendance overview is shown below. Open QR Scanner without a lecture asks you to confirm a new lecture first.
                </p>
              ) : null}
              {classId && hasMoreLectures ? (
                <button
                  type="button"
                  onClick={() => setLecturePage((page) => page + 1)}
                  disabled={lectureLoad.kind === "loading"}
                  className="self-start text-xs font-semibold text-[#112D5C] underline disabled:opacity-50"
                >
                  Load more lectures in {monthLabel(month)}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {classOptions === null ? (
          <p className="border-t border-slate-100 px-3 py-2 text-xs leading-snug text-slate-500">The class list could not be loaded. Reload the page to take attendance.</p>
        ) : null}
        {lectureLoad.kind === "error" ? (
          <p role="alert" className="border-t border-slate-100 px-3 py-2 text-xs text-rose-700">
            The lectures could not be loaded: {lectureLoad.message}
          </p>
        ) : null}

        {mode !== "REGISTER" ? (
          // Overview mode: the month's matrix inside this same card, below a divider (no second card).
          <div
            role="region"
            aria-labelledby={MONTHLY_OVERVIEW_HEADING_ID}
            className="flex min-w-0 flex-col border-t border-slate-200"
            data-workspace-mode={mode === "OVERVIEW" ? "overview" : "no-class"}
            aria-busy={matrixLoad.kind === "loading"}
          >
            <h3 id={MONTHLY_OVERVIEW_HEADING_ID} className="sr-only">
              {className ? `Monthly attendance: ${classMonthTitle(className, month)}` : `Monthly attendance: ${monthLabel(month)}`}
            </h3>
            {mode === "NO_CLASS" ? (
              <div className="p-3">
                <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600" data-empty-state={noClasses ? "no-classes" : "no-class"}>
                  {noClasses
                    ? "You have no classes yet. Create a class first; its attendance will appear here."
                    : classOptions === null
                      ? "Your classes could not be loaded. Reload the page to see attendance."
                      : classesLoaded
                        ? `Choose a class (Change) to see its attendance for ${monthLabel(month)}.`
                        : "Loading your classes…"}
                </p>
              </div>
            ) : (
              <>
                {matrixLoad.kind === "loading" ? (
                  <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-slate-600">
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                    Loading attendance…
                  </p>
                ) : null}
                {matrixLoad.kind === "ready" && matrixLoad.refreshing ? (
                  <p role="status" className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-600">
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                    Updating attendance…
                  </p>
                ) : null}
                {matrixLoad.kind === "error" ? (
                  <div className="p-3">
                    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                      {matrixLoad.error.message}
                      <button type="button" onClick={reloadMatrix} className="inline-flex items-center gap-1 font-semibold underline">
                        <RefreshCw size={12} aria-hidden />
                        Try again
                      </button>
                    </div>
                  </div>
                ) : null}
                {matrix ? (
                  <>
                    <AttendanceMatrixTable matrix={matrix} selectedLectureId={null} flush />
                    <div className="rounded-b-xl border-t border-slate-100 px-3 py-2">
                      <MatrixLegend />
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {dialogOpen && classId ? (
          <AttendanceLectureDialog
            classId={classId}
            className={className}
            schedules={matrix ? matrix.schedules : null}
            graceMinutes={matrix ? matrix.class.attendanceGraceMinutes : null}
            onClose={() => setDialogOpen(false)}
            onLectureReady={lectureReady}
          />
        ) : null}

        {scanner && classId ? (
          <QrScannerModal key={`${scanner.lectureId}:${scanner.opening}`} lectureId={scanner.lectureId} className={className || null} onClose={closeScanner} />
        ) : null}
      </section>

      {mode === "REGISTER" ? (
        // Register mode: the selected lecture's register below the control card (its own content section; no matrix).
        <section aria-labelledby={LECTURE_ATTENDANCE_HEADING_ID} className="flex min-w-0 flex-col" data-workspace-mode="register">
          <h2 id={LECTURE_ATTENDANCE_HEADING_ID} className="sr-only">
            {selectedLecture ? `Lecture attendance: ${lectureOptionLabel(selectedLecture)}` : "Lecture attendance"}
          </h2>
          <LectureAttendanceRegisterPanel key={lectureId} lectureId={lectureId} variant="embedded" onOpenScanner={openSelectedScanner} refreshKey={registerRefresh} />
        </section>
      ) : null}
    </>
  );
}
