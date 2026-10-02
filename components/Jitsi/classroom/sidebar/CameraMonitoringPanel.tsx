"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import type { CameraMonitoringController } from "../../hooks/useCameraMonitoring";

type CameraMonitoringPanelProps = {
  /** Owned by JitsiClassroom (useCameraMonitoring); this panel only displays it. */
  monitoring: CameraMonitoringController;
};

// Selected / idle styles for the small segmented buttons (softer navy for the
// selected fill, matching the teacher panel's button color).
const segmentClass = (selected: boolean) =>
  `rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
    selected
      ? "border-[#4D6C90] bg-[#4D6C90] text-white hover:bg-[#3B5776]"
      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
  }`;

const pagerButtonClass =
  "flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50";

export default function CameraMonitoringPanel({
  monitoring,
}: CameraMonitoringPanelProps) {
  const isExam = monitoring.mode === "exam";
  const presentCount = monitoring.presentStudents.length;
  const receivingCount = monitoring.activeParticipantIds.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-slate-900">

      {/* MODE */}
      <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Mode</h3>

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Monitoring mode">
          <button
            type="button"
            aria-pressed={!isExam}
            onClick={() => monitoring.setMode("normal")}
            className={segmentClass(!isExam)}
          >
            Normal
          </button>

          <button
            type="button"
            aria-pressed={isExam}
            onClick={() => monitoring.setMode("exam")}
            className={segmentClass(isExam)}
          >
            Exam Mode
          </button>
        </div>

        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          {isExam
            ? "You receive only the cameras of the students on the current page."
            : "Jitsi chooses which student cameras you receive. Paging applies in Exam Mode."}
        </p>
      </div>

      {/* PAGE SIZE + PAGINATION */}
      <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Students per page</h3>

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Students per page">
          {monitoring.pageSizeOptions.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={monitoring.pageSize === size}
              onClick={() => monitoring.setPageSize(size)}
              className={segmentClass(monitoring.pageSize === size)}
            >
              {size}
            </button>
          ))}
        </div>

        {/* Pagination (exam mode, once someone is present) */}
        {isExam && monitoring.pageCount > 0 ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={!monitoring.canGoPrevious}
              onClick={monitoring.goToPreviousPage}
              className={pagerButtonClass}
            >
              <ChevronLeft size={12} />
              Previous
            </button>

            <span className="text-xs font-semibold text-slate-700">
              Page {monitoring.page} of {monitoring.pageCount}
            </span>

            <button
              type="button"
              disabled={!monitoring.canGoNext}
              onClick={monitoring.goToNextPage}
              className={pagerButtonClass}
            >
              Next
              <ChevronRight size={12} />
            </button>
          </div>
        ) : null}
      </div>

      {/* RECEIVING */}
      <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Receiving</h3>

          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
            {isExam
              ? `${receivingCount} of ${presentCount} students`
              : `${presentCount} in the meeting`}
          </span>
        </div>

        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          {!isExam
            ? "All student cameras are handled by Jitsi's normal selection."
            : presentCount === 0
              ? "No students in the meeting yet. They appear here once they join."
              : `Receiving cameras of students ${monitoring.pageRangeStart}–${monitoring.pageRangeEnd} of ${presentCount} in the meeting.`}
        </p>
      </div>
    </div>
  );
}
