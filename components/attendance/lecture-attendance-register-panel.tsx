"use client";

/*
 * The teacher's attendance register for one lecture (Stage 5.5d-2). Loads
 * GET /api/lectures/[id]/attendance through the shared helper
 * (components/attendance/attendance-ui.ts) and shows the register header,
 * the backend's summary counts and every student, with search and filters
 * applied to the data already loaded. Actions: online evidence
 * reconciliation (Stage 5.5d-3: reconcile-section.tsx,
 * reconciliation-controller.ts) and finalization (Stage 5.5d-4:
 * finalization-dialog.tsx, finalization-controller.ts), never both at once
 * (a shared action lock); after either, the register is reloaded in place.
 * Manual status decisions (Stage 5.6d: decision-dialog.tsx) and answers to
 * pending evidence reviews (Stage 5.6e: review-dialog.tsx) go through ONE
 * record-action-controller.ts, so a decision and a review are never in
 * flight together; both are allowed while reconciliation runs (they do not
 * take the shared register lock); the server's version check settles any
 * race. History (Stage 5.6f, history-views.tsx, read only): each student's
 * record history in a dialog, and the register's own history in a separate
 * section (there is no lecture-wide feed of student changes). The server
 * decides who may see the register (404 for another teacher's lecture);
 * nothing is cached or stored in the browser. QR attendance (Stage
 * 5.7b-3d, qr-scan-entry.tsx): the register's QR state and, while it is
 * open, a "Scan QR codes" link to the scanner page; Stage 5.7b-3e adds the
 * permanent "Close QR attendance" action (qr-closure-dialog.tsx,
 * qr-closure-controller.ts), separate from finalization.
 *
 * This is the canonical attendance register (one record per student per
 * lecture), not the session join / leave log shown on the lecture list.
 *
 * Embedded use (the Attendance page, attendance-take-section.tsx): the same
 * panel with variant="embedded" under the class matrix for the selected
 * lecture: the class name in the header, no "Back to lectures" bar, compact
 * icon actions (change status, history), "Open QR scanner" opening the
 * page's scanner modal (onOpenScanner) instead of the scanner route,
 * `refreshKey` to reload after the modal closes, and `onRefreshed` after
 * every applied reload (the page then reloads its matrix). Every action,
 * controller, dialog, API and server rule is the page's own; nothing is
 * duplicated. The standalone route renders the default (page) variant.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  Clock,
  FileX,
  Info,
  Lock,
  LockOpen,
  QrCode,
  RefreshCw,
  Search,
  ServerCrash,
  ShieldAlert,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";

import {
  absenceDecisionLabel,
  attendanceErrorAction,
  attendanceStatusLabel,
  eligibilityLabel,
  evidenceChannels,
  evidenceSummaryLabel,
  fetchAttendanceRegister,
  formatColomboDateTime,
  graceResultMessage,
  runReconciliation,
  statusSourceLabel,
  type AttendanceApiError,
  type AttendanceRegisterResponse,
  type BadgeTone,
  type ReasonProblem,
  type ReviewAction,
} from "@/components/attendance/attendance-ui";
import { ReconcileSection, reconcileAvailability } from "@/components/attendance/reconcile-section";
import {
  checkDecisionDraft,
  DecisionAction,
  DecisionDialog,
  decisionTargetOf,
  REGISTER_STUDENTS_ID,
  type DecisionDraft,
  type DecisionDraftProblem,
  type DecisionStep,
  type DecisionTarget,
} from "@/components/attendance/decision-dialog";
import { HistoryAction, RegisterHistorySection, StudentHistoryDialog, type StudentHistoryTarget } from "@/components/attendance/history-views";
import {
  checkGraceDraft,
  GraceAction,
  GraceDialog,
  graceChangeAvailability,
  graceTargetOf,
  REGISTER_SCHEDULE_ID,
  type GraceDraft,
  type GraceDraftProblem,
  type GraceStep,
  type GraceTarget,
} from "@/components/attendance/grace-dialog";
import { createGraceController, type GraceController, type GraceUiState } from "@/components/attendance/grace-controller";
import {
  checkReviewReason,
  ReviewActions,
  ReviewDialog,
  reviewTargetOf,
  type ReviewTarget,
} from "@/components/attendance/review-dialog";
import {
  createRecordActionController,
  type RecordActionController,
  type RecordActionUiState,
} from "@/components/attendance/record-action-controller";
import { FinalizationDialog, FinalizationSection, finalizeAvailability } from "@/components/attendance/finalization-dialog";
import { QrScanEntry, qrClosureAvailability } from "@/components/attendance/qr-scan-entry";
import { QrClosureDialog, qrClosureTargetOf, type QrClosureTarget } from "@/components/attendance/qr-closure-dialog";
import { createQrClosureController, type QrClosureController, type QrClosureUiState } from "@/components/attendance/qr-closure-controller";
import {
  createFinalizationController,
  type FinalizationController,
  type FinalizationUiState,
} from "@/components/attendance/finalization-controller";
import {
  createActionLock,
  createLatestRequestGate,
  createReconcileController,
  type ReconcileController,
  type ReconcileUiState,
} from "@/components/attendance/reconciliation-controller";

type RegisterStudent = AttendanceRegisterResponse["students"][number];

// =========================================================================================
// Pure helpers (exported for tests)
// =========================================================================================

export type RegisterStatusFilter = "ALL" | "PRESENT" | "LATE" | "ABSENT" | "EXCUSED" | "NO_RECORD";
export type RegisterReviewFilter = "ALL" | "PENDING" | "NONE";
export type RegisterFilters = { search: string; status: RegisterStatusFilter; review: RegisterReviewFilter };

export const DEFAULT_REGISTER_FILTERS: RegisterFilters = { search: "", status: "ALL", review: "ALL" };

/**
 * The students matching the filters, in the API's order. Search: the name or
 * the registration number contains the text (trimmed, case-insensitive).
 * Status: the record's canonical status, or NO_RECORD. Review: a pending
 * teacher review or none.
 */
export function filterRegisterStudents(students: readonly RegisterStudent[], filters: RegisterFilters): RegisterStudent[] {
  const needle = filters.search.trim().toLowerCase();
  return students.filter((student) => {
    if (needle) {
      const name = (student.name ?? "").toLowerCase();
      const registration = (student.registrationNumber ?? "").toLowerCase();
      if (!name.includes(needle) && !registration.includes(needle)) return false;
    }
    if (filters.status === "NO_RECORD" ? student.record !== null : filters.status !== "ALL" && student.record?.status !== filters.status) {
      return false;
    }
    if (filters.review === "PENDING" && !student.review.pending) return false;
    if (filters.review === "NONE" && student.review.pending) return false;
    return true;
  });
}

/** An API timestamp (UTC ISO) in Sri Lankan time; "—" when absent or invalid (moved to attendance-ui.ts in Stage 5.6f; same function). */
export { formatColomboDateTime };

const LECTURE_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const TONE_CLASSES: Record<BadgeTone, string> = {
  positive: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
};

// =========================================================================================
// Presentational pieces
// =========================================================================================

/** A status pill: always a text label (never colour alone). */
function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

function StatusCell({ student }: { student: RegisterStudent }) {
  const status = attendanceStatusLabel(student.record?.status ?? null);
  const evidence = student.record?.autoStatus ? attendanceStatusLabel(student.record.autoStatus) : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={status.tone}>{status.label}</Badge>
      {evidence ? <span className="text-[11px] text-slate-500">Evidence status: {evidence.label}</span> : null}
    </div>
  );
}

function EvidenceCell({ student }: { student: RegisterStudent }) {
  const channels = evidenceChannels(student.record);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-700">{evidenceSummaryLabel(student.record)}</span>
      {channels.map((channel) => (
        <span key={channel.channel} className="inline-flex items-center gap-1 text-[11px] text-slate-500">
          {channel.channel === "ONLINE" ? <Wifi size={11} aria-hidden /> : <QrCode size={11} aria-hidden />}
          {channel.channel === "ONLINE" ? "Online" : "QR"}
        </span>
      ))}
    </div>
  );
}

function EligibilityCell({ student }: { student: RegisterStudent }) {
  const eligibility = eligibilityLabel(student.eligibility);
  const decision = absenceDecisionLabel(student.absenceDecision);
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={eligibility.tone}>{eligibility.label}</Badge>
      {decision ? <span className="text-[11px] text-slate-500">{decision}</span> : null}
    </div>
  );
}

function ReviewCell({ student }: { student: RegisterStudent }) {
  return student.review.pending ? (
    <Badge tone="warning">
      <AlertTriangle size={11} aria-hidden />
      Pending review since {formatColomboDateTime(student.review.since)}
    </Badge>
  ) : (
    <span className="text-xs text-slate-500">No pending review</span>
  );
}

type SummaryTone = "navy" | "positive" | "warning" | "danger" | "info";

const SUMMARY_TONES: Record<SummaryTone, string> = {
  navy: "bg-[#eef3f8] text-[#32598A]",
  positive: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-rose-50 text-rose-700",
  info: "bg-sky-50 text-sky-700",
};

/** One of the six summary counts (the server's value): an icon box, a small label, a clearly readable number. */
function SummaryCard({ label, value, icon, tone = "navy" }: { label: string; value: number; icon: React.ReactNode; tone?: SummaryTone }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm" data-summary-card>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${SUMMARY_TONES[tone]}`}>{icon}</span>
      <div className="min-w-0">
        <p className="break-words text-[12px] font-medium leading-tight text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold leading-none tabular-nums text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800">{value}</dd>
    </div>
  );
}

const STATUS_FILTER_OPTIONS: { value: RegisterStatusFilter; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "PRESENT", label: "Present" },
  { value: "LATE", label: "Late" },
  { value: "ABSENT", label: "Absent" },
  { value: "EXCUSED", label: "Excused" },
  { value: "NO_RECORD", label: "No record" },
];

const REVIEW_FILTER_OPTIONS: { value: RegisterReviewFilter; label: string }[] = [
  { value: "ALL", label: "All review states" },
  { value: "PENDING", label: "Pending review" },
  { value: "NONE", label: "No pending review" },
];

/**
 * The register itself, from loaded data: header, notices, summary, filters
 * and the students (a table on wide screens, cards with the same fields on
 * narrow ones; nothing is left out on either).
 */
export type RegisterVariant = "page" | "embedded";

export function RegisterView({
  register,
  filters,
  onFiltersChange,
  actions,
  onChangeStatus,
  onReview,
  onViewHistory,
  onChangeGrace,
  onCloseQrAttendance,
  variant = "page",
  className = null,
  onOpenScanner,
  compactActions = false,
}: {
  register: AttendanceRegisterResponse;
  filters: RegisterFilters;
  onFiltersChange: (filters: RegisterFilters) => void;
  /** Register actions (Stage 5.5d-3: online evidence reconciliation), shown below the notices. */
  actions?: React.ReactNode;
  /** Stage 5.6d: opens the manual decision dialog for a student (both layouts); absent → no per-student action. */
  onChangeStatus?: (student: RegisterStudent) => void;
  /** Stage 5.6e: opens the review dialog (Accept / Dismiss) for a pending review (both layouts). */
  onReview?: (student: RegisterStudent, action: ReviewAction) => void;
  /** Stage 5.6f: opens the student's attendance history (both layouts). */
  onViewHistory?: (student: RegisterStudent) => void;
  /** Stage 5.7b-2b-3: opens the grace-period dialog (shown only for an open register of a lecture that is not cancelled). */
  onChangeGrace?: () => void;
  /** Stage 5.7b-3e: opens the "Close QR attendance" confirmation (offered only while the closure is allowed). */
  onCloseQrAttendance?: () => void;
  /** "embedded": on the Attendance page (an h3 title, the class name). Default: the register page. */
  variant?: RegisterVariant;
  /** The class name shown in the embedded header (the register names only the class id). */
  className?: string | null;
  /** The Attendance page: "Open QR scanner" opens its scanner modal (no navigation). */
  onOpenScanner?: () => void;
  /** Icon buttons for Change status / View history (tooltips and accessible names). */
  compactActions?: boolean;
}) {
  const hasActions = Boolean(onChangeStatus || onReview || onViewHistory);
  const embedded = variant === "embedded";
  const visible = filterRegisterStudents(register.students, filters);
  const { lecture, summary } = register;
  const finalized = register.register.finalized;
  const unconfigured = register.configuration.approval !== "OK" || register.configuration.evidence !== "OK";
  const filtered = filters.search.trim() !== "" || filters.status !== "ALL" || filters.review !== "ALL";

  /** The six server counts; on the Attendance page they come right after the lecture header (seen first). */
  const summaryCards = (
    <section aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <SummaryCard label="Students" value={summary.students} icon={<Users size={16} aria-hidden />} />
      <SummaryCard label="Present" value={summary.recordStatus.PRESENT} tone="positive" icon={<CheckCircle2 size={16} aria-hidden />} />
      <SummaryCard label="Late" value={summary.recordStatus.LATE} tone="warning" icon={<Clock size={16} aria-hidden />} />
      <SummaryCard label="Absent" value={summary.recordStatus.ABSENT} tone="danger" icon={<FileX size={16} aria-hidden />} />
      <SummaryCard label="Excused" value={summary.recordStatus.EXCUSED} tone="info" icon={<CircleHelp size={16} aria-hidden />} />
      <SummaryCard label="Pending reviews" value={summary.pendingReviews} tone="warning" icon={<AlertTriangle size={16} aria-hidden />} />
    </section>
  );

  return (
    <div className={`flex flex-col ${embedded ? "gap-3" : "gap-4"}`}>
      {/* Header (embedded on the Attendance page: a light card; the register page keeps its navy header) */}
      {embedded ? (
        <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm" aria-label="Lecture" data-register-header="embedded">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {className ? <p className="break-words text-[12px] font-medium text-slate-500 sm:text-[13px]">{className}</p> : null}
              <h3 className="mt-0.5 break-words text-lg font-semibold text-slate-900">{lecture.title}</h3>
              <p className="mt-0.5 text-[12px] text-slate-600 sm:text-[13px]">
                Lecture status: {LECTURE_STATUS_LABELS[lecture.classStatus] ?? lecture.classStatus}
                {register.classification ? ` · ${register.classification === "LIVE" ? "Automatic attendance" : "Before automatic attendance (historical)"}` : ""}
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold ${
                finalized ? "border-slate-300 bg-slate-100 text-slate-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              {finalized ? <Lock size={13} aria-hidden /> : <LockOpen size={13} aria-hidden />}
              {finalized ? "Finalized" : "Open"}
            </span>
          </div>
          <dl id={REGISTER_SCHEDULE_ID} tabIndex={-1} className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3 outline-none sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Scheduled start" value={formatColomboDateTime(register.register.scheduledStartAt)} />
            <Detail label="Scheduled end" value={register.register.scheduledEndAt ? formatColomboDateTime(register.register.scheduledEndAt) : "No end time"} />
            <Detail
              label="Grace period"
              value={
                <>
                  {`${register.register.graceMinutes} minutes`}
                  {onChangeGrace ? <GraceAction register={register} onOpen={onChangeGrace} /> : null}
                </>
              }
            />
            <Detail label="Finalized" value={finalized ? formatColomboDateTime(register.register.finalizedAt) : "Not finalized"} />
          </dl>
        </section>
      ) : (
        <section className="rounded-2xl bg-[#112D5C] p-4 text-white shadow-sm sm:p-5" aria-label="Lecture">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70">Attendance register</p>
              <h1 className="mt-1 break-words text-xl font-bold sm:text-2xl">{lecture.title}</h1>
              <p className="mt-1 text-xs text-white/80">
                Lecture status: {LECTURE_STATUS_LABELS[lecture.classStatus] ?? lecture.classStatus}
                {register.classification ? ` · ${register.classification === "LIVE" ? "Automatic attendance" : "Before automatic attendance (historical)"}` : ""}
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                finalized ? "bg-white text-[#112D5C]" : "bg-white/15 text-white ring-1 ring-white/40"
              }`}
            >
              {finalized ? <Lock size={13} aria-hidden /> : <LockOpen size={13} aria-hidden />}
              {finalized ? "Finalized" : "Open"}
            </span>
          </div>
          <dl id={REGISTER_SCHEDULE_ID} tabIndex={-1} className="mt-4 grid grid-cols-1 gap-3 rounded-xl bg-white p-3 outline-none sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Scheduled start" value={formatColomboDateTime(register.register.scheduledStartAt)} />
            <Detail label="Scheduled end" value={register.register.scheduledEndAt ? formatColomboDateTime(register.register.scheduledEndAt) : "No end time"} />
            <Detail
              label="Grace period"
              value={
                <>
                  {`${register.register.graceMinutes} minutes`}
                  {onChangeGrace ? <GraceAction register={register} onOpen={onChangeGrace} /> : null}
                </>
              }
            />
            <Detail label="Finalized" value={finalized ? formatColomboDateTime(register.register.finalizedAt) : "Not finalized"} />
          </dl>
        </section>
      )}

      {embedded ? summaryCards : null}

      {/* Notices (read-only information) */}
      <div className="flex flex-col gap-2">
        {unconfigured ? (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            Attendance settings are not fully configured on this server, so eligibility and online-evidence details are not available.
          </p>
        ) : null}
        {!register.register.exists ? (
          <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
            No attendance has been recorded for this lecture yet. The schedule shown is the one attendance will use.
          </p>
        ) : null}
        {register.activeSessions.active ? (
          <p className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <Wifi size={16} className="mt-0.5 shrink-0" aria-hidden />
            A live class session is in progress for this lecture.
          </p>
        ) : null}
        {register.onlineEvidence && !register.onlineEvidence.complete ? (
          <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
            Online evidence not yet recorded: {register.onlineEvidence.pending.length} student(s). Approval unknown at join:{" "}
            {register.onlineEvidence.unknownVisits.length} student(s).
          </p>
        ) : null}
      </div>

      {/* QR attendance (Stage 5.7b-3d): the state and, when open, the link to the scanner page. */}
      <QrScanEntry register={register} onCloseQr={onCloseQrAttendance} onOpenScanner={onOpenScanner} />

      {actions}

      {embedded ? null : summaryCards}

      {/* Filters (on the loaded data) */}
      <section aria-label="Filters" className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
          Search by name or registration number
          <span className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={filters.search}
              onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
              placeholder="e.g. Perera or REG-102"
              className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-2 text-sm font-normal text-slate-800 outline-none focus:border-[#112D5C]"
            />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Attendance status
          <select
            value={filters.status}
            onChange={(event) => onFiltersChange({ ...filters, status: event.target.value as RegisterStatusFilter })}
            className="h-9 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800"
          >
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Review
          <select
            value={filters.review}
            onChange={(event) => onFiltersChange({ ...filters, review: event.target.value as RegisterReviewFilter })}
            className="h-9 rounded-lg border border-slate-200 px-2 text-sm font-normal text-slate-800"
          >
            {REVIEW_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {filtered ? (
          <button
            type="button"
            onClick={() => onFiltersChange(DEFAULT_REGISTER_FILTERS)}
            className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Clear filters
          </button>
        ) : null}
      </section>

      <p id={REGISTER_STUDENTS_ID} tabIndex={-1} className="text-xs text-slate-500 outline-none" aria-live="polite">
        Showing {visible.length} of {register.students.length} student(s)
      </p>

      {register.students.length === 0 ? (
        <EmptyState icon={<Users size={20} aria-hidden />} title="No students on this register" body="No student is enrolled in this lecture's class or has an attendance record for it." />
      ) : visible.length === 0 ? (
        <EmptyState icon={<Search size={20} aria-hidden />} title="No students match the filters" body="Change the search text or the filters to see more students." />
      ) : (
        <>
          {/* Wide screens: a table (scrolls sideways when needed, every column kept). */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block" data-layout="table">
            <table className={`w-full ${hasActions ? (compactActions ? "min-w-[1220px]" : "min-w-[1340px]") : "min-w-[1100px]"} text-left text-sm`}>
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Registration no.</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Evidence</th>
                  <th className="px-3 py-2">First online</th>
                  <th className="px-3 py-2">First QR</th>
                  <th className="px-3 py-2">Teacher decision</th>
                  <th className="px-3 py-2">Eligibility at start</th>
                  <th className="px-3 py-2">Review</th>
                  {hasActions ? <th className="px-3 py-2">Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((student) => (
                  <tr key={student.studentId} className="align-top">
                    <td className="px-3 py-2 font-medium text-slate-900">{student.name ?? "Unknown student"}</td>
                    <td className="px-3 py-2 text-slate-700">{student.registrationNumber ?? "—"}</td>
                    <td className="px-3 py-2"><StatusCell student={student} /></td>
                    <td className="px-3 py-2 text-xs text-slate-700">{statusSourceLabel(student.record?.statusSource ?? null)}</td>
                    <td className="px-3 py-2"><EvidenceCell student={student} /></td>
                    <td className="px-3 py-2 text-xs text-slate-700">{formatColomboDateTime(student.record?.firstOnlineAt)}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">{formatColomboDateTime(student.record?.firstQrAt)}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">{formatColomboDateTime(student.record?.teacherDecidedAt)}</td>
                    <td className="px-3 py-2"><EligibilityCell student={student} /></td>
                    <td className="px-3 py-2"><ReviewCell student={student} /></td>
                    {hasActions ? (
                      <td className="px-3 py-2">
                        {compactActions ? (
                          <div className="flex flex-col items-start gap-1.5">
                            <div className="flex items-center gap-1.5">
                              {onChangeStatus ? <DecisionAction student={student} register={register} onOpen={onChangeStatus} compact /> : null}
                              {onViewHistory ? <HistoryAction student={student} onOpen={onViewHistory} compact /> : null}
                            </div>
                            {onReview ? <ReviewActions student={student} register={register} onOpen={onReview} /> : null}
                          </div>
                        ) : (
                          <div className="flex flex-col items-start gap-1.5">
                            {onChangeStatus ? <DecisionAction student={student} register={register} onOpen={onChangeStatus} /> : null}
                            {onReview ? <ReviewActions student={student} register={register} onOpen={onReview} /> : null}
                            {onViewHistory ? <HistoryAction student={student} onOpen={onViewHistory} /> : null}
                          </div>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow screens: cards with the same fields. */}
          <ul className="flex flex-col gap-2 md:hidden" data-layout="cards">
            {visible.map((student) => (
              <li key={student.studentId} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words font-semibold text-slate-900">{student.name ?? "Unknown student"}</p>
                    <p className="text-xs text-slate-600">Registration no.: {student.registrationNumber ?? "—"}</p>
                  </div>
                  <StatusCell student={student} />
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                  <Detail label="Source" value={statusSourceLabel(student.record?.statusSource ?? null)} />
                  <Detail label="Evidence" value={<EvidenceCell student={student} />} />
                  <Detail label="First online" value={formatColomboDateTime(student.record?.firstOnlineAt)} />
                  <Detail label="First QR" value={formatColomboDateTime(student.record?.firstQrAt)} />
                  <Detail label="Teacher decision" value={formatColomboDateTime(student.record?.teacherDecidedAt)} />
                  <Detail label="Eligibility at start" value={<EligibilityCell student={student} />} />
                  <Detail label="Review" value={<ReviewCell student={student} />} />
                </dl>
                {hasActions ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    {onChangeStatus ? <DecisionAction student={student} register={register} onOpen={onChangeStatus} compact={compactActions} /> : null}
                    {onViewHistory && compactActions ? <HistoryAction student={student} onOpen={onViewHistory} compact /> : null}
                    {onReview ? <ReviewActions student={student} register={register} onOpen={onReview} /> : null}
                    {onViewHistory && !compactActions ? <HistoryAction student={student} onOpen={onViewHistory} /> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <span className="text-slate-400">{icon}</span>
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="max-w-md text-sm text-slate-500">{body}</p>
    </div>
  );
}

/**
 * A failed load: the message comes from the shared helper (never server
 * internals); what is offered follows the error code. Retrying is always
 * the teacher's choice (no automatic retries).
 */
export function RegisterErrorView({ error, onRetry, backLink = true }: { error: AttendanceApiError; onRetry?: () => void; backLink?: boolean }) {
  const action = attendanceErrorAction(error.code);
  const notFound = error.code === "LECTURE_NOT_FOUND" || (error.status === 404 && error.code !== "UNAUTHORIZED");
  const configuration = error.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" || error.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED";
  const title = notFound
    ? "Lecture not found"
    : error.code === "UNAUTHORIZED"
      ? "Please sign in again"
      : configuration
        ? "Attendance is not configured"
        : error.code === "NETWORK_ERROR"
          ? "Could not reach the server"
          : "The register could not be loaded";
  const icon = notFound ? <FileX size={22} aria-hidden /> : error.code === "NETWORK_ERROR" ? <WifiOff size={22} aria-hidden /> : configuration ? <ShieldAlert size={22} aria-hidden /> : <ServerCrash size={22} aria-hidden />;

  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <span className="text-[#112D5C]">{icon}</span>
      <p className="text-lg font-semibold text-slate-900">{title}</p>
      <p className="max-w-md text-sm text-slate-600">
        {notFound ? "This lecture does not exist or is not one of your lectures." : error.message}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {action === "SIGN_IN" ? (
          <Link href="/login" className="rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            Sign in
          </Link>
        ) : null}
        {(action === "RETRY" || action === "RELOAD_PAGE") && onRetry ? (
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg bg-[#112D5C] px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <RefreshCw size={14} aria-hidden />
            Try again
          </button>
        ) : null}
        {backLink ? (
          <Link href="/dashboard/lectures" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Back to lectures
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function RegisterLoadingView() {
  return (
    <div role="status" className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
      <RefreshCw size={16} className="animate-spin text-[#112D5C]" aria-hidden />
      Loading the attendance register…
    </div>
  );
}

// =========================================================================================
// The panel (loads the register)
// =========================================================================================

const EMPTY_DECISION_DRAFT: DecisionDraft = { status: null, reason: "" };

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: AttendanceApiError }
  | { kind: "ready"; register: AttendanceRegisterResponse };

export type LectureAttendanceRegisterPanelProps = {
  lectureId: string;
  /** "embedded": on the Attendance page. Default: the standalone register page. */
  variant?: RegisterVariant;
  /** The class name for the embedded header. */
  className?: string | null;
  /** Opens the Attendance page's scanner modal for this lecture. */
  onOpenScanner?: () => void;
  /** Changing it reloads the register (e.g. after the scanner modal closed). */
  refreshKey?: number;
  /** After every reload that was not superseded: applied (true) or failed (false). */
  onRefreshed?: (applied: boolean) => void;
};

export function LectureAttendanceRegisterPanel({
  lectureId,
  variant = "page",
  className = null,
  onOpenScanner,
  refreshKey,
  onRefreshed,
}: LectureAttendanceRegisterPanelProps) {
  const embedded = variant === "embedded";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filters, setFilters] = useState<RegisterFilters>(DEFAULT_REGISTER_FILTERS);
  const [reconcileState, setReconcileState] = useState<ReconcileUiState>({ phase: "idle" });
  const [finalizationState, setFinalizationState] = useState<FinalizationUiState>({ phase: "closed" });
  const [acknowledged, setAcknowledged] = useState(false);
  // Stage 5.6d: the manual decision dialog (a snapshot of the student taken when it opens).
  const [decisionTarget, setDecisionTarget] = useState<DecisionTarget | null>(null);
  const [decisionDraft, setDecisionDraft] = useState<DecisionDraft>(EMPTY_DECISION_DRAFT);
  const [decisionStep, setDecisionStep] = useState<DecisionStep>("edit");
  const [decisionProblem, setDecisionProblem] = useState<DecisionDraftProblem | null>(null);
  const [recordAction, setRecordAction] = useState<RecordActionUiState>({ phase: "idle" });
  // Stage 5.6e: the review dialog (Accept / Dismiss), also a snapshot taken when it opens.
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewStep, setReviewStep] = useState<DecisionStep>("edit");
  const [reviewProblem, setReviewProblem] = useState<ReasonProblem | null>(null);
  // Stage 5.6f: the student whose history dialog is open (read only).
  const [historyTarget, setHistoryTarget] = useState<StudentHistoryTarget | null>(null);
  // Stage 5.7b-2b-3: the grace-period dialog (a snapshot of the register taken when it opens).
  const [graceTarget, setGraceTarget] = useState<GraceTarget | null>(null);
  const [graceDraft, setGraceDraft] = useState<GraceDraft>({ value: "", reason: "" });
  const [graceStep, setGraceStep] = useState<GraceStep>("edit");
  const [graceProblem, setGraceProblem] = useState<GraceDraftProblem | null>(null);
  const [graceReasonRequired, setGraceReasonRequired] = useState(false);
  const [graceState, setGraceState] = useState<GraceUiState>({ phase: "idle" });
  const graceController = useRef<GraceController | null>(null);
  // Stage 5.7b-3e: the QR closure confirmation (a snapshot of the register taken when it opens).
  const [qrCloseTarget, setQrCloseTarget] = useState<QrClosureTarget | null>(null);
  const [qrCloseState, setQrCloseState] = useState<QrClosureUiState>({ phase: "idle" });
  const qrCloseController = useRef<QrClosureController | null>(null);
  /** The register most recently applied by load() (the closure controller reads it after a refresh). */
  const latestRegister = useRef<AttendanceRegisterResponse | null>(null);
  /** The latest onRefreshed (a ref, so load() and the controllers built on it keep their identity). */
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;

  // Only the newest load may update the page (initial load, retry, refresh after reconciliation).
  const gate = useRef(createLatestRequestGate());
  const inFlight = useRef<AbortController | null>(null);
  const reconciler = useRef<ReconcileController | null>(null);
  const finalization = useRef<FinalizationController | null>(null);
  const recordActions = useRef<RecordActionController | null>(null);

  /** Loads the register. A refresh keeps the current data on screen (and on failure). Resolves true when applied. */
  const load = useCallback(
    async (mode: "initial" | "refresh"): Promise<boolean> => {
      const id = gate.current.begin();
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      if (mode === "initial") setState({ kind: "loading" });
      const result = await fetchAttendanceRegister(lectureId, { signal: controller.signal });
      if (!gate.current.isCurrent(id) || controller.signal.aborted) return false;
      if (result.ok) {
        latestRegister.current = result.data;
        setState({ kind: "ready", register: result.data });
        if (mode === "refresh") onRefreshedRef.current?.(true);
        return true;
      }
      if (mode === "initial") setState({ kind: "error", error: result });
      else onRefreshedRef.current?.(false);
      return false;
    },
    [lectureId]
  );

  useEffect(() => {
    void load("initial");
    const currentGate = gate.current;
    return () => {
      currentGate.invalidate();
      inFlight.current?.abort();
    };
  }, [load]);

  // One reconciliation and one finalization controller per lecture, sharing one action lock (never
  // both at once); both disposed (requests aborted, callbacks ignored) on unmount.
  useEffect(() => {
    const lock = createActionLock();
    const controller = createReconcileController({
      lectureId,
      lock,
      run: runReconciliation,
      refresh: () => load("refresh"),
      onChange: (next) => {
        setReconcileState(next);
        if (next.phase !== "done" || next.refresh === "pending") return;
        if (next.outcome.status === "COMPLETE") toast.success("Online evidence reconciled.");
        else if (next.outcome.status === "FAILED") toast.error(next.outcome.error.message);
      },
    });
    const finalizer = createFinalizationController({
      lectureId,
      lock,
      refresh: () => load("refresh"),
      onChange: (next) => {
        setFinalizationState(next);
        // A new preview (or none) always needs a new explicit acknowledgement.
        if (next.phase !== "preview" && next.phase !== "submitting") setAcknowledged(false);
        if (next.phase === "finalized" && next.refresh !== "pending") {
          toast.success(next.result.alreadyFinalized ? "Attendance was already finalized." : "Attendance finalized.");
        }
      },
    });
    reconciler.current = controller;
    finalization.current = finalizer;
    setReconcileState({ phase: "idle" });
    setFinalizationState({ phase: "closed" });
    setAcknowledged(false);
    return () => {
      controller.dispose();
      finalizer.dispose();
      if (reconciler.current === controller) reconciler.current = null;
      if (finalization.current === finalizer) finalization.current = null;
    };
  }, [lectureId, load]);

  // Manual decisions (Stage 5.6d): one controller per lecture, WITHOUT the shared action lock, so
  // decisions stay possible while reconciliation runs (the server's version check settles races).
  // It prevents duplicate submissions, never retries, and refreshes the register after a success, a
  // 409 or a cancellation (never an optimistic local change); disposed on unmount.
  useEffect(() => {
    const controller = createRecordActionController({
      lectureId,
      refresh: () => load("refresh"),
      onChange: (next) => {
        setRecordAction(next);
        if (next.phase === "succeeded" && next.kind === "decision" && next.refresh !== "pending") {
          if (next.refresh === "done") toast.success(`Attendance changed to ${attendanceStatusLabel(next.result.status).label}.`);
          else toast.error("The change was saved, but the register could not be refreshed. Reload the page.");
          setDecisionTarget(null);
        }
        if (next.phase === "succeeded" && next.kind === "review" && next.refresh !== "pending") {
          if (next.refresh === "done") {
            toast.success(next.result.action === "ACCEPT" ? `Evidence accepted: ${attendanceStatusLabel(next.result.status).label}.` : "Evidence dismissed; the status is unchanged.");
          } else {
            toast.error("The review was answered, but the register could not be refreshed. Reload the page.");
          }
          setReviewTarget(null);
        }
      },
    });
    recordActions.current = controller;
    setRecordAction({ phase: "idle" });
    setDecisionTarget(null);
    setReviewTarget(null);
    return () => {
      controller.dispose();
      if (recordActions.current === controller) recordActions.current = null;
    };
  }, [lectureId, load]);

  const openDecision = useCallback(
    (student: AttendanceRegisterResponse["students"][number]) => {
      const controller = recordActions.current;
      if (state.kind !== "ready" || !controller || controller.isBusy() || reviewTarget) return;
      controller.reset();
      setDecisionTarget(decisionTargetOf(student, state.register));
      setDecisionDraft(EMPTY_DECISION_DRAFT);
      setDecisionStep("edit");
      setDecisionProblem(null);
    },
    [state, reviewTarget]
  );
  const closeDecision = useCallback(() => {
    const controller = recordActions.current;
    if (controller?.isBusy()) return;
    controller?.reset();
    setDecisionTarget(null);
  }, []);
  const continueDecision = useCallback(() => {
    if (!decisionTarget) return;
    const check = checkDecisionDraft(decisionTarget, decisionDraft);
    setDecisionProblem(check.ok ? null : check.problem);
    if (check.ok) setDecisionStep("confirm");
  }, [decisionTarget, decisionDraft]);
  const confirmDecision = useCallback(() => {
    const controller = recordActions.current;
    if (!decisionTarget || !controller) return;
    const check = checkDecisionDraft(decisionTarget, decisionDraft);
    if (!check.ok) {
      setDecisionProblem(check.problem);
      setDecisionStep("edit");
      return;
    }
    // The version is the snapshot's (the register as the teacher saw it): never a newer one.
    void controller.submitDecision({
      target: { studentId: decisionTarget.studentId, record: decisionTarget.record },
      status: check.status,
      reason: check.reason,
      finalized: decisionTarget.finalized,
    });
  }, [decisionTarget, decisionDraft]);

  const openReview = useCallback(
    (student: AttendanceRegisterResponse["students"][number], action: ReviewAction) => {
      const controller = recordActions.current;
      if (state.kind !== "ready" || !controller || controller.isBusy() || decisionTarget) return;
      const target = reviewTargetOf(student, state.register, action);
      if (!target) return;
      controller.reset();
      setReviewTarget(target);
      setReviewReason("");
      setReviewStep("edit");
      setReviewProblem(null);
    },
    [state, decisionTarget]
  );
  const closeReview = useCallback(() => {
    const controller = recordActions.current;
    if (controller?.isBusy()) return;
    controller?.reset();
    setReviewTarget(null);
  }, []);
  const continueReview = useCallback(() => {
    if (!reviewTarget) return;
    const check = checkReviewReason(reviewTarget.action, reviewReason);
    setReviewProblem(check.ok ? null : check.problem);
    if (check.ok) setReviewStep("confirm");
  }, [reviewTarget, reviewReason]);
  const confirmReview = useCallback(() => {
    const controller = recordActions.current;
    if (!reviewTarget || !controller) return;
    const check = checkReviewReason(reviewTarget.action, reviewReason);
    if (!check.ok) {
      setReviewProblem(check.problem);
      setReviewStep("edit");
      return;
    }
    // The snapshot's version (the register as the teacher saw it) and the action chosen when it opened.
    void controller.submitReview({
      target: { studentId: reviewTarget.studentId, record: reviewTarget.record },
      action: reviewTarget.action,
      reason: check.reason,
    });
  }, [reviewTarget, reviewReason]);

  const openHistory = useCallback(
    (student: AttendanceRegisterResponse["students"][number]) => {
      if (decisionTarget || reviewTarget || student.name === null) return;
      setHistoryTarget({ studentId: student.studentId, name: student.name, registrationNumber: student.registrationNumber });
    },
    [decisionTarget, reviewTarget]
  );
  const closeHistory = useCallback(() => setHistoryTarget(null), []);

  // The grace period (Stage 5.7b-2b-3): one controller per lecture, without the register lock (the
  // server serializes it with reconciliation and finalization); it never retries, refreshes the
  // register after a success or a 409, and is disposed (request aborted) on unmount.
  useEffect(() => {
    const controller = createGraceController({
      lectureId,
      refresh: () => load("refresh"),
      onChange: (next) => {
        setGraceState(next);
        if (next.phase === "succeeded" && next.refresh !== "pending") {
          if (next.refresh === "done") toast.success(graceResultMessage(next.result));
          else toast.error("The grace period was saved, but the register could not be refreshed. Reload the page.");
          setGraceTarget(null);
        }
        if (next.phase === "failed" && next.reasonRequired) {
          // The server asks for a reason: back to the form, reason required; the teacher resubmits.
          setGraceReasonRequired(true);
          setGraceStep("edit");
          setGraceProblem({ field: "reason", problem: "REQUIRED" });
        }
      },
    });
    graceController.current = controller;
    setGraceState({ phase: "idle" });
    setGraceTarget(null);
    return () => {
      controller.dispose();
      if (graceController.current === controller) graceController.current = null;
    };
  }, [lectureId, load]);

  const openGrace = useCallback(() => {
    const controller = graceController.current;
    if (state.kind !== "ready" || !controller || controller.isBusy() || decisionTarget || reviewTarget || historyTarget) return;
    if (!graceChangeAvailability(state.register).allowed) return;
    controller.reset();
    const target = graceTargetOf(state.register);
    setGraceTarget(target);
    setGraceDraft({ value: String(target.currentGraceMinutes), reason: "" });
    setGraceStep("edit");
    setGraceProblem(null);
    setGraceReasonRequired(false);
  }, [state, decisionTarget, reviewTarget, historyTarget]);
  const closeGrace = useCallback(() => {
    const controller = graceController.current;
    if (controller?.isBusy()) return;
    controller?.reset();
    setGraceTarget(null);
  }, []);
  const continueGrace = useCallback(() => {
    if (!graceTarget) return;
    const check = checkGraceDraft(graceTarget, graceDraft, graceReasonRequired);
    setGraceProblem(check.ok ? null : check.problem);
    if (check.ok) setGraceStep("confirm");
  }, [graceTarget, graceDraft, graceReasonRequired]);
  const confirmGrace = useCallback(() => {
    const controller = graceController.current;
    if (!graceTarget || !controller) return;
    const check = checkGraceDraft(graceTarget, graceDraft, graceReasonRequired);
    if (!check.ok) {
      setGraceProblem(check.problem);
      setGraceStep("edit");
      return;
    }
    // The snapshot's version (the register as the teacher saw it): never a newer one.
    void controller.submit({ graceMinutes: check.graceMinutes, expectedVersion: graceTarget.expectedVersion, reason: check.reason });
  }, [graceTarget, graceDraft, graceReasonRequired]);
  // QR attendance closure (Stage 5.7b-3e): one controller per lecture, without the register lock
  // (the server serializes the closure on the register row); it never retries, refreshes the
  // register after a success or an ambiguous / gone failure, and is disposed on unmount.
  useEffect(() => {
    const controller = createQrClosureController({
      lectureId,
      refresh: async () => ((await load("refresh")) ? latestRegister.current : null),
      onChange: (next) => {
        setQrCloseState(next);
        if (next.phase === "succeeded" && next.refresh !== "pending") {
          if (next.refresh === "done") {
            const at = formatColomboDateTime(next.result.closedAt);
            toast.success(
              next.result.alreadyClosed
                ? `QR attendance was already closed (on ${at}).`
                : `QR attendance closed on ${at}. No more QR scans will be accepted.`
            );
          } else {
            toast.error("QR attendance was closed, but the register could not be refreshed. Reload the page.");
          }
          setQrCloseTarget(null);
        }
        if (next.phase === "confirmed") {
          toast.success(`QR attendance is closed${next.closedAt ? ` (closed on ${formatColomboDateTime(next.closedAt)})` : ""}.`);
          setQrCloseTarget(null);
        }
      },
    });
    qrCloseController.current = controller;
    setQrCloseState({ phase: "idle" });
    setQrCloseTarget(null);
    return () => {
      controller.dispose();
      if (qrCloseController.current === controller) qrCloseController.current = null;
    };
  }, [lectureId, load]);

  const openQrClose = useCallback(() => {
    const controller = qrCloseController.current;
    if (state.kind !== "ready" || !controller || controller.isBusy() || decisionTarget || reviewTarget || historyTarget || graceTarget) return;
    if (!qrClosureAvailability(state.register).allowed) return;
    controller.reset();
    setQrCloseTarget(qrClosureTargetOf(state.register));
  }, [state, decisionTarget, reviewTarget, historyTarget, graceTarget]);
  const closeQrClose = useCallback(() => {
    const controller = qrCloseController.current;
    if (controller?.isBusy()) return;
    controller?.reset();
    setQrCloseTarget(null);
  }, []);
  const confirmQrClose = useCallback(() => void qrCloseController.current?.confirm(), []);

  // A new lecture: no history dialog left open.
  useEffect(() => setHistoryTarget(null), [lectureId]);

  // The embedding page asks for a reload (e.g. after QR scanning in its modal); not on mount.
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = refreshKey;
    void load("refresh");
  }, [refreshKey, load]);

  const retry = useCallback(() => void load("initial"), [load]);
  const startReconcile = useCallback(() => void reconciler.current?.start(), []);
  const cancelReconcile = useCallback(() => reconciler.current?.cancel(), []);
  const openFinalization = useCallback(() => void finalization.current?.open(), []);
  const reloadPreview = useCallback(() => void finalization.current?.reloadPreview(), []);
  const confirmFinalization = useCallback(() => void finalization.current?.confirm(acknowledged), [acknowledged]);
  const closeFinalization = useCallback(() => void finalization.current?.close(), []);

  const content = useMemo(() => {
    if (state.kind === "loading") return <RegisterLoadingView />;
    if (state.kind === "error") return <RegisterErrorView error={state.error} onRetry={retry} backLink={!embedded} />;
    return (
      <RegisterView
        register={state.register}
        filters={filters}
        onFiltersChange={setFilters}
        onChangeStatus={openDecision}
        onReview={openReview}
        onViewHistory={openHistory}
        onChangeGrace={openGrace}
        onCloseQrAttendance={openQrClose}
        variant={variant}
        className={className}
        onOpenScanner={onOpenScanner}
        compactActions={embedded}
        actions={
          <>
            <ReconcileSection
              availability={
                finalizationState.phase === "closed"
                  ? reconcileAvailability(state.register)
                  : { allowed: false, reason: "Close the finalization dialog to reconcile online evidence.", note: null }
              }
              state={reconcileState}
              onStart={startReconcile}
              onCancel={cancelReconcile}
            />
            <FinalizationSection
              register={state.register}
              availability={finalizeAvailability(state.register, reconcileState.phase === "running")}
              onPreview={openFinalization}
            />
          </>
        }
      />
    );
  }, [state, filters, retry, reconcileState, startReconcile, cancelReconcile, finalizationState, openFinalization, openDecision, openReview, openHistory, openGrace, openQrClose, variant, className, onOpenScanner, embedded]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-register-variant={variant}>
      {embedded ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/dashboard/lectures" className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#112D5C] hover:underline">
            <ArrowLeft size={15} aria-hidden />
            Back to lectures
          </Link>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <ClipboardList size={14} aria-hidden />
            Attendance register
          </span>
        </div>
      )}
      {content}
      {state.kind === "ready" ? <RegisterHistorySection lectureId={lectureId} registerVersion={state.register.register.version} /> : null}
      <FinalizationDialog
        state={finalizationState}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onConfirm={confirmFinalization}
        onReloadPreview={reloadPreview}
        onClose={closeFinalization}
      />
      <DecisionDialog
        target={decisionTarget}
        draft={decisionDraft}
        step={decisionStep}
        problem={decisionProblem}
        action={recordAction}
        onStatusChange={(status) => {
          setDecisionDraft((draft) => ({ ...draft, status }));
          setDecisionProblem(null);
        }}
        onReasonChange={(reason) => {
          setDecisionDraft((draft) => ({ ...draft, reason }));
          setDecisionProblem(null);
        }}
        onContinue={continueDecision}
        onBack={() => setDecisionStep("edit")}
        onConfirm={confirmDecision}
        onClose={closeDecision}
      />
      <ReviewDialog
        target={reviewTarget}
        reason={reviewReason}
        step={reviewStep}
        problem={reviewProblem}
        action={recordAction}
        onReasonChange={(reason) => {
          setReviewReason(reason);
          setReviewProblem(null);
        }}
        onContinue={continueReview}
        onBack={() => setReviewStep("edit")}
        onConfirm={confirmReview}
        onClose={closeReview}
      />
      <StudentHistoryDialog lectureId={lectureId} target={historyTarget} onClose={closeHistory} />
      <GraceDialog
        target={graceTarget}
        draft={graceDraft}
        step={graceStep}
        problem={graceProblem}
        reasonRequired={graceReasonRequired}
        state={graceState}
        onValueChange={(value) => {
          setGraceDraft((draft) => ({ ...draft, value }));
          setGraceProblem(null);
        }}
        onReasonChange={(reason) => {
          setGraceDraft((draft) => ({ ...draft, reason }));
          setGraceProblem(null);
        }}
        onContinue={continueGrace}
        onBack={() => setGraceStep("edit")}
        onConfirm={confirmGrace}
        onClose={closeGrace}
      />
      <QrClosureDialog target={qrCloseTarget} state={qrCloseState} onConfirm={confirmQrClose} onClose={closeQrClose} />
    </div>
  );
}
