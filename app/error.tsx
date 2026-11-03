"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

import useErrorReport from "@/components/error-reporting/useErrorReport";

/**
 * Error boundary for every page under the root layout (a route's own
 * error.tsx takes precedence). The error is reported to the server log; the
 * user sees no technical details, only a reference for support.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const reference = useErrorReport(error, "error-boundary:app");
  const router = useRouter();

  // reset() alone re-renders the same failed server output: a server
  // rendering error needs the page's server data fetched again first
  // (router.refresh), in one transition so the boundary resets once the new
  // data has arrived. Client-side errors are simply rendered again.
  const tryAgain = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  return (
    <main className="flex min-h-[70vh] w-full flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>

        <h1 className="mt-4 text-lg font-semibold text-slate-900">Something went wrong</h1>

        <p className="mt-2 text-sm leading-6 text-slate-600">
          This page ran into an unexpected problem. Please try again. If it keeps happening,
          reload the page or come back in a few minutes.
        </p>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={tryAgain}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#112D5C] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0c2249] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#112D5C]/40"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Reload page
          </button>

          <a
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            <Home className="h-4 w-4" aria-hidden="true" />
            Home
          </a>
        </div>

        {reference && (
          <p className="mt-6 text-xs text-slate-400">
            Reference: <span className="font-mono">{reference}</span>
          </p>
        )}
      </div>
    </main>
  );
}
