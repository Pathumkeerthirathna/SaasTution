/*
 * The Attendance page's compact heading (the Students page's header pattern:
 * an icon box, the title, a one-line subtitle). No card of its own: it sits at
 * the top of the Attendance workspace's single card
 * (attendance-take-section.tsx), or in a plain card when the overview is shown
 * without the workspace (attendance-overview-panel.tsx).
 */

import { ClipboardList } from "lucide-react";

export function AttendancePageHeading() {
  return (
    <header className="flex min-w-0 items-center gap-3" data-page-header>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#32598A] text-white">
        <ClipboardList size={18} aria-hidden />
      </span>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Attendance</h1>
        <p className="break-words text-[12px] text-slate-500 sm:text-[13px]">Manage class attendance and lecture registers. Times are Sri Lankan time.</p>
      </div>
    </header>
  );
}
