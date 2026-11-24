"use client";

/*
 * "Open QR Scanner" with a class but no lecture (Attendance page): the
 * teacher creates a normal lecture for today's session, then the existing
 * QR scanner opens for it. Nothing is created without the explicit
 * confirmation step.
 *
 *  1. Form: today's ClassSchedule rows for the Sri Lankan weekday (choose
 *     one when there are several), or an additional / manual session. The
 *     date (today in Asia/Colombo) and the schedule's start / end are
 *     prefilled and editable; so is the title.
 *  2. Confirm: a summary in Sri Lankan time, with the QR timing notes: a
 *     past start means the existing grace rule will mark scans LATE; a
 *     future start means scanning opens 30 minutes before it. The rules
 *     themselves are never changed or bypassed here.
 *  3. Duplicate (409 ATTENDANCE_LECTURE_EXISTS from the server's
 *     transaction-safe check): use the existing lecture, or confirm an
 *     additional session.
 *
 * Times are sent as Sri Lankan "YYYY-MM-DDTHH:MM" values (createLectureSchema
 * reads them as Asia/Colombo, whatever the browser's time zone).
 */

import { useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CalendarPlus, Info, Loader2, QrCode, X } from "lucide-react";

import { createAttendanceLecture, formatColomboDateTime, type AttendanceLectureBody } from "@/components/attendance/attendance-ui";
import { useModalDialog } from "@/components/attendance/use-modal-dialog";
import { qrScanOpensAt } from "@/lib/attendance/evidence";
import { LECTURE_END_DATE_MESSAGES, lectureEndDateProblem } from "@/lib/lecture-schedule";
import { parseSriLankaLocalDateTime, sriLankaCalendarParts, sriLankaDateKey } from "@/lib/time";
import type { AttendanceMatrixSchedule } from "@/services/class-attendance-matrix-service";

export const TAKE_ATTENDANCE_BUTTON_ID = "attendance-open-qr-scanner";

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

/** The Weekday enum by Sri Lankan weekday number (0 = Sunday, as sriLankaCalendarParts). */
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
const WEEKDAY_LABEL: Record<string, string> = {
  SUNDAY: "Sunday",
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
};

export const weekdayLabel = (day: string) => WEEKDAY_LABEL[day] ?? day;

/** Today in Asia/Colombo: the calendar day "YYYY-MM-DD" and the Weekday enum value. */
export function colomboToday(now: Date): { day: string; weekday: string } {
  return { day: sriLankaDateKey(now), weekday: WEEKDAYS[sriLankaCalendarParts(now).weekday] };
}

/** The class's schedules on a weekday, earliest first. */
export function schedulesForWeekday(schedules: readonly AttendanceMatrixSchedule[], weekday: string): AttendanceMatrixSchedule[] {
  return schedules.filter((s) => s.dayOfWeek === weekday).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const LECTURE_TITLE_MAX = 150;

/** "<class> – 24 Nov 2026" (at most 150 characters, the lecture title limit). */
export function defaultLectureTitle(className: string, day: string): string {
  const label = DAY_PATTERN.test(day) ? DAY_FORMAT.format(new Date(`${day}T00:00:00.000Z`)) : day;
  const suffix = ` – ${label}`;
  return `${className.trim().slice(0, LECTURE_TITLE_MAX - suffix.length)}${suffix}`;
}

export const MANUAL_SESSION = "manual";

export type SessionForm = {
  /** A schedule id, or MANUAL_SESSION. */
  choice: string;
  day: string;
  start: string;
  end: string;
  title: string;
  /** The teacher typed a title: date changes no longer replace it. */
  titleEdited: boolean;
};

/** The form as it opens: the first of today's schedules (else a manual session), today, its times. */
export function initialSessionForm(input: { todays: readonly AttendanceMatrixSchedule[]; today: string; className: string }): SessionForm {
  const first = input.todays[0];
  return {
    choice: first ? first.id : MANUAL_SESSION,
    day: input.today,
    start: first ? first.startTime : "",
    end: first ? first.endTime : "",
    title: defaultLectureTitle(input.className, input.today),
    titleEdited: false,
  };
}

/** Choosing a schedule fills its times; the manual session keeps what was typed. */
export function chooseSession(form: SessionForm, choice: string, schedules: readonly AttendanceMatrixSchedule[]): SessionForm {
  const schedule = schedules.find((s) => s.id === choice);
  return schedule ? { ...form, choice, start: schedule.startTime, end: schedule.endTime } : { ...form, choice: MANUAL_SESSION };
}

/** A new date: the default title follows it unless the teacher edited the title. */
export function changeDay(form: SessionForm, day: string, className: string): SessionForm {
  return { ...form, day, title: form.titleEdited ? form.title : defaultLectureTitle(className, day) };
}

export const sessionStart = (form: SessionForm): Date | null =>
  DAY_PATTERN.test(form.day) && TIME_PATTERN.test(form.start) ? parseSriLankaLocalDateTime(`${form.day}T${form.start}`) : null;

export const sessionEnd = (form: SessionForm): Date | null =>
  DAY_PATTERN.test(form.day) && TIME_PATTERN.test(form.end) ? parseSriLankaLocalDateTime(`${form.day}T${form.end}`) : null;

/** The first problem with the form (the server checks everything again), or null. */
export function sessionFormProblem(form: SessionForm): string | null {
  const title = form.title.trim();
  if (title.length < 2) return "Lecture title must be at least 2 characters long.";
  if (title.length > LECTURE_TITLE_MAX) return `Lecture title must be at most ${LECTURE_TITLE_MAX} characters long.`;
  if (!DAY_PATTERN.test(form.day)) return "Choose the session date.";
  const start = sessionStart(form);
  if (!start) return "Enter a valid start time.";
  if (form.end.trim() === "") return null;
  const end = sessionEnd(form);
  if (!end) return "Enter a valid end time.";
  const problem = lectureEndDateProblem(start, end);
  return problem ? LECTURE_END_DATE_MESSAGES[problem] : null;
}

export type SessionTiming =
  | { kind: "NOW" }
  /** start + grace has passed: the existing grace rule marks scans LATE. */
  | { kind: "PAST" }
  /** QR scanning opens 30 minutes before the start (the existing window). */
  | { kind: "FUTURE"; opensAt: Date };

/** How the existing QR rules will treat this session at `now` (informational; the server decides). */
export function sessionTiming(start: Date, now: Date, graceMinutes: number | null): SessionTiming {
  const opensAt = qrScanOpensAt(start);
  if (opensAt.getTime() > now.getTime()) return { kind: "FUTURE", opensAt };
  if (start.getTime() + (graceMinutes ?? 0) * 60_000 < now.getTime()) return { kind: "PAST" };
  return { kind: "NOW" };
}

/** The request body (Sri Lankan wall-clock values; no end time when the field is empty). */
export function lectureBody(form: SessionForm, allowAdditionalSession: boolean): AttendanceLectureBody {
  return {
    title: form.title.trim(),
    date: `${form.day}T${form.start}`,
    endDate: form.end.trim() === "" ? null : `${form.day}T${form.end}`,
    allowAdditionalSession,
  };
}

export type ExistingLecture = { id: string; title: string; date: string; endDate: string | null };

/** The existing lectures a 409 ATTENDANCE_LECTURE_EXISTS reports (an empty list for anything else). */
export function existingLecturesOf(details: unknown): ExistingLecture[] {
  if (typeof details !== "object" || details === null || !Array.isArray((details as { lectures?: unknown }).lectures)) return [];
  return ((details as { lectures: unknown[] }).lectures).filter(
    (item): item is ExistingLecture =>
      typeof item === "object" && item !== null && typeof (item as ExistingLecture).id === "string" && typeof (item as ExistingLecture).date === "string"
  );
}

// =========================================================================================
// The dialog
// =========================================================================================

type Step = { kind: "form" } | { kind: "confirm" } | { kind: "duplicate"; lectures: ExistingLecture[] };

export function AttendanceLectureDialog(props: {
  classId: string;
  className: string;
  /** Null: the class's schedules could not be loaded (a manual session is still possible). */
  schedules: AttendanceMatrixSchedule[] | null;
  graceMinutes: number | null;
  onClose: () => void;
  /** A lecture to scan for: the new one, or an existing one the teacher chose after a duplicate warning. */
  onLectureReady: (lecture: ExistingLecture) => void;
  now?: () => Date;
}) {
  const nowFn = props.now ?? (() => new Date());
  const [today] = useState(() => colomboToday(nowFn()));
  const todays = schedulesForWeekday(props.schedules ?? [], today.weekday);
  const [form, setForm] = useState<SessionForm>(() => initialSessionForm({ todays, today: today.day, className: props.className }));
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const { refocus } = useModalDialog({ open: true, dialogRef, overlayRef, canClose: () => !busy, onClose: props.onClose, fallbackId: TAKE_ATTENDANCE_BUTTON_ID });

  const problem = sessionFormProblem(form);
  const start = sessionStart(form);
  const end = form.end.trim() === "" ? null : sessionEnd(form);
  const timing = start ? sessionTiming(start, nowFn(), props.graceMinutes) : null;
  const isToday = form.day === today.day;

  async function submit(allowAdditionalSession: boolean) {
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    const result = await createAttendanceLecture(props.classId, lectureBody(form, allowAdditionalSession));
    setBusy(false);
    if (result.ok) {
      const created = result.data.lecture;
      props.onLectureReady({ id: created.id, title: created.title, date: created.date, endDate: created.endDate });
      return;
    }
    if (result.code === "ATTENDANCE_LECTURE_EXISTS") {
      setStep({ kind: "duplicate", lectures: existingLecturesOf(result.details) });
      refocus();
      return;
    }
    setError(result.message);
    refocus();
  }

  const goTo = (next: Step) => {
    setError(null);
    setStep(next);
    refocus();
  };

  return (
    <div ref={overlayRef} data-dialog-overlay className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attendance-lecture-dialog-title"
        aria-describedby="attendance-lecture-dialog-description"
        aria-busy={busy}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 bg-[#112D5C] px-4 py-3 text-white">
          <div className="min-w-0">
            <h2 id="attendance-lecture-dialog-title" className="flex items-center gap-1.5 text-base font-semibold">
              <CalendarPlus size={16} aria-hidden />
              {step.kind === "confirm" ? "Confirm the new lecture" : step.kind === "duplicate" ? "A lecture already exists" : "Create a lecture for attendance"}
            </h2>
            <p id="attendance-lecture-dialog-description" className="break-words text-xs text-white/80">
              {props.className} · Times are Sri Lankan time.
            </p>
          </div>
          <button type="button" onClick={props.onClose} disabled={busy} aria-label="Close" className="rounded-md p-1 text-white/90 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50">
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-4 text-sm text-slate-800">
          {step.kind === "form" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!problem) goTo({ kind: "confirm" });
              }}
            >
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs font-semibold text-slate-600">Session ({weekdayLabel(today.weekday)} schedules)</legend>
                {props.schedules === null ? (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">The class schedules could not be loaded. Enter the session times manually.</p>
                ) : todays.length === 0 ? (
                  <p className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">This class has no schedule on {weekdayLabel(today.weekday)}. Enter an additional session&apos;s date and times.</p>
                ) : null}
                {todays.map((schedule, index) => (
                  <label key={schedule.id} className="flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                    <input
                      type="radio"
                      name="attendance-session"
                      value={schedule.id}
                      checked={form.choice === schedule.id}
                      onChange={() => setForm((f) => chooseSession(f, schedule.id, todays))}
                      data-autofocus={index === 0 ? true : undefined}
                    />
                    <span>
                      Scheduled session {schedule.startTime}–{schedule.endTime}
                    </span>
                  </label>
                ))}
                <label className="flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                  <input
                    type="radio"
                    name="attendance-session"
                    value={MANUAL_SESSION}
                    checked={form.choice === MANUAL_SESSION}
                    onChange={() => setForm((f) => chooseSession(f, MANUAL_SESSION, todays))}
                    data-autofocus={todays.length === 0 ? true : undefined}
                  />
                  <span>Additional / manual session</span>
                </label>
              </fieldset>

              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                Lecture title
                <input
                  type="text"
                  value={form.title}
                  maxLength={LECTURE_TITLE_MAX}
                  onChange={(event) => setForm((f) => ({ ...f, title: event.target.value, titleEdited: true }))}
                  className="h-10 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800"
                />
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  Date
                  <input type="date" required value={form.day} onChange={(event) => setForm((f) => changeDay(f, event.target.value, props.className))} className="h-10 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  Start time
                  <input type="time" required value={form.start} onChange={(event) => setForm((f) => ({ ...f, start: event.target.value }))} className="h-10 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  End time (optional)
                  <input type="time" value={form.end} onChange={(event) => setForm((f) => ({ ...f, end: event.target.value }))} className="h-10 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800" />
                </label>
              </div>

              {problem ? <p className="text-xs text-rose-700" role="status">{problem}</p> : null}
              <TimingNote timing={timing} isToday={isToday} graceMinutes={props.graceMinutes} />

              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={props.onClose} className="min-h-[44px] rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  Cancel
                </button>
                <button type="submit" disabled={problem !== null} className="min-h-[44px] rounded-lg bg-[#112D5C] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                  Review
                </button>
              </div>
            </form>
          ) : null}

          {step.kind === "confirm" && start ? (
            <div className="flex flex-col gap-3">
              <p>A new lecture will be created in this class, and the QR scanner will open for it.</p>
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <dt className="font-semibold text-slate-600">Title</dt>
                <dd className="break-words">{form.title.trim()}</dd>
                <dt className="font-semibold text-slate-600">Starts</dt>
                <dd>{formatColomboDateTime(start.toISOString())}</dd>
                <dt className="font-semibold text-slate-600">Ends</dt>
                <dd>{end ? formatColomboDateTime(end.toISOString()) : "No end time"}</dd>
              </dl>
              <TimingNote timing={timing} isToday={isToday} graceMinutes={props.graceMinutes} />
              {error ? <p role="alert" className="text-xs text-rose-700">{error}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => goTo({ kind: "form" })} disabled={busy} className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <ArrowLeft size={14} aria-hidden />
                  Back
                </button>
                <button type="button" data-autofocus onClick={() => void submit(false)} disabled={busy} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <QrCode size={14} aria-hidden />}
                  Confirm and open QR scanner
                </button>
              </div>
            </div>
          ) : null}

          {step.kind === "duplicate" ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                This class already has a lecture at this time on this day. Use it for attendance, or create an additional session only if this really is a separate session.
              </p>
              <ul className="flex flex-col gap-2">
                {step.lectures.map((lecture, index) => (
                  <li key={lecture.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                    <span className="min-w-0">
                      <span className="block break-words font-medium">{lecture.title}</span>
                      <span className="block text-xs text-slate-600">
                        {formatColomboDateTime(lecture.date)}
                        {lecture.endDate ? ` – ${formatColomboDateTime(lecture.endDate)}` : ""}
                      </span>
                    </span>
                    <button type="button" data-autofocus={index === 0 ? true : undefined} onClick={() => props.onLectureReady(lecture)} disabled={busy} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
                      <QrCode size={14} aria-hidden />
                      Use this lecture
                    </button>
                  </li>
                ))}
              </ul>
              {error ? <p role="alert" className="text-xs text-rose-700">{error}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => goTo({ kind: "form" })} disabled={busy} className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <ArrowLeft size={14} aria-hidden />
                  Back
                </button>
                <button type="button" onClick={() => void submit(true)} disabled={busy} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[#112D5C] px-4 text-sm font-semibold text-[#112D5C] hover:bg-slate-50 disabled:opacity-50">
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                  Create an additional session anyway
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The QR timing note for the chosen start (the existing rules, explained; never changed). */
export function TimingNote({ timing, isToday, graceMinutes }: { timing: SessionTiming | null; isToday: boolean; graceMinutes: number | null }) {
  if (!timing) return null;
  if (timing.kind === "PAST") {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-timing="past">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
        {isToday ? "This start time has already passed." : "This date is in the past."} Under the existing attendance rules, scans recorded more than
        {graceMinutes === null ? " the grace period" : ` ${graceMinutes} minute(s)`} after the start are marked Late.
      </p>
    );
  }
  if (timing.kind === "FUTURE") {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900" data-timing="future">
        <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
        QR scanning for this lecture opens at {formatColomboDateTime(timing.opensAt.toISOString())}, 30 minutes before the start. Until then the scanner
        shows that scanning is not open yet.
      </p>
    );
  }
  return null;
}
