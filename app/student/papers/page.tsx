import { Suspense } from "react";
import { ScrollText } from "lucide-react";

import { StudentPapersClient } from "@/components/student-portal/student-papers-client";
import { requireStudentSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export default async function StudentPapersPage() {
  await requireStudentSession();

  return (
    <section className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <ScrollText size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-900">Papers</h1>
          <p className="text-xs text-slate-500">View papers from your teachers and submit your answers.</p>
        </div>
      </header>
      <div className="p-3">
        <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-slate-100" />}>
          <StudentPapersClient />
        </Suspense>
      </div>
    </section>
  );
}
