import { Suspense } from "react";
import { CalendarClock } from "lucide-react";

import { LectureListClient } from "@/components/student-portal/lecture-list-client";
import { requireStudentSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export default async function StudentLecturesPage() {
  await requireStudentSession();

  return (
    <section className="overflow-hidden rounded-xl border border-brand-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <CalendarClock size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-foreground">Lecture / Schedules</h1>
          <p className="text-xs text-muted">Lecture materials, recordings and your class schedule.</p>
        </div>
      </header>
      <div className="p-3">
        <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-slate-100" />}>
          <LectureListClient />
        </Suspense>
      </div>
    </section>
  );
}
