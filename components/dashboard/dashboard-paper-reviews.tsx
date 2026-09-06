"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, ScrollText } from "lucide-react";

import { useTeacherLiveRefetch } from "@/components/dashboard/use-teacher-live-events";

type PaperReview = {
  submissionId: string;
  submittedAt: string | null;
  studentName: string;
  registrationNumber: string | null;
  paperId: string;
  paperName: string;
  startTime: string;
  endTime: string;
  classId: string;
  className: string;
};

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DashboardPaperReviews() {
  const [reviews, setReviews] = useState<PaperReview[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  // Realtime: re-pull when a student submits a paper or a teacher marks one.
  useTeacherLiveRefetch(() => setLiveTick((n) => n + 1));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch("/api/dashboard/paper-reviews", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const body = (await res.json()) as {
          success: boolean;
          data?: PaperReview[];
          error?: { message?: string };
        };
        if (!res.ok || !body.success || !body.data) {
          throw new Error(body.error?.message ?? "Failed to load.");
        }
        setReviews(body.data);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load.");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [liveTick]);

  const skeleton = (
    <div className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-brand-50" />
      ))}
    </div>
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-4">
        <div className="flex items-center gap-2">
          <ScrollText size={16} className="text-emerald-600" />
          <h2 className="font-bold text-foreground">Paper submissions to review</h2>
        </div>
        <Link
          href="/dashboard/papers"
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
        >
          View all <ArrowRight size={12} />
        </Link>
      </div>

      <div className="p-5">
        {error ? (
          <p className="rounded-xl border border-dashed border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-600">
            Couldn&apos;t load paper submissions.
          </p>
        ) : loading ? (
          skeleton
        ) : (reviews?.length ?? 0) === 0 ? (
          <p className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-muted">
            No paper submissions are waiting to be marked.
          </p>
        ) : (
          <div className="space-y-2">
            {reviews!.map((r) => (
              <Link
                key={r.submissionId}
                href={`/dashboard/papers?paperId=${r.paperId}&classId=${r.classId}&focus=${r.submissionId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3 transition hover:border-emerald-300 hover:bg-emerald-50/60"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-foreground">{r.paperName}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {r.className} &middot; {r.studentName}
                    {r.registrationNumber && (
                      <span className="text-muted"> ({r.registrationNumber})</span>
                    )}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                    <CalendarClock size={11} />
                    {fmtDateTime(r.startTime)} → {fmtDateTime(r.endTime)}
                  </p>
                </div>
                <p className="flex-shrink-0 text-xs font-semibold text-emerald-700">
                  {r.submittedAt ? `Submitted ${fmtDateTime(r.submittedAt)}` : "Submitted"}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
