"use client";

import { LayoutDashboard, RotateCcw, WifiOff } from "lucide-react";

import useErrorReport from "@/components/error-reporting/useErrorReport";

// Back to the dashboard of the role the classroom was opened with.
function dashboardPath() {
  try {
    return new URLSearchParams(window.location.search).get("role") === "teacher" ? "/dashboard" : "/student/dashboard";
  } catch {
    return "/";
  }
}

/**
 * The live classroom's own error screen (dark, full screen, like the
 * classroom). Reloading is the safe way back: it loads the current version
 * of the page and returns to the Device Setup step. It does not join the
 * meeting, mark attendance or change the session; the user joins again
 * themselves. The error is reported to the server log; no technical details
 * are shown.
 */
export default function ClassroomError({ error }: { error: Error & { digest?: string } }) {
  const reference = useErrorReport(error, "error-boundary:classroom");

  return (
    <main className="flex h-screen h-dvh w-full items-center justify-center overflow-y-auto bg-[#0B1120] px-4 py-8">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.07] bg-[#0F172A] p-6 text-center shadow-[0_24px_60px_-28px_rgba(2,6,23,0.9)] sm:p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#3B82F6]/15 text-[#93C5FD]">
          <WifiOff className="h-6 w-6" aria-hidden="true" />
        </div>

        <h1 className="mt-4 text-lg font-semibold text-white">The classroom couldn&apos;t load</h1>

        <p className="mt-2 text-sm leading-6 text-slate-400">
          Something interrupted the classroom page. Reloading usually fixes this. You&apos;ll be
          back at the camera and microphone setup, and can join the class again from there.
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-gradient-to-b from-[#3B82F6] to-[#2563EB] text-sm font-semibold text-white transition hover:from-[#4C8DF7] hover:to-[#2F6DEE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/70"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reload classroom
          </button>

          <button
            type="button"
            onClick={() => window.location.assign(dashboardPath())}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[10px] text-sm font-semibold text-slate-300 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.06] hover:text-white"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
            Back to dashboard
          </button>
        </div>

        {reference && (
          <p className="mt-6 text-xs text-slate-500">
            Reference: <span className="font-mono">{reference}</span>
          </p>
        )}
      </div>
    </main>
  );
}
