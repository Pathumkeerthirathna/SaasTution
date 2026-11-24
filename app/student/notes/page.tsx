import { NotebookPen } from "lucide-react";

import { StudentNotesClient } from "@/components/student-portal/notes/student-notes-client";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * The student's Notes page: a class's General Notes and its lectures' notes
 * (components/student-portal/notes/student-notes-client.tsx).
 *
 * The class list is read here, on the server, for the signed-in student only:
 * ACTIVE enrolments in ACTIVE classes (the classes the notes API serves).
 * Nothing about classes comes from the browser; every notes and file request
 * re-checks the enrolment and the monthly resource access on the server.
 * `?classId=` (the dashboard's links) only pre-selects a class when it is one
 * of these classes; anything else is ignored.
 */
export default async function StudentNotesPage({ searchParams }: { searchParams?: { classId?: string | string[] } }) {
  const session = await requireStudentSession();

  const enrolments = await prisma.classStudent.findMany({
    where: { studentId: session.studentId, isActive: true, class: { status: 0 } },
    select: { class: { select: { id: true, name: true } } },
    orderBy: { class: { name: "asc" } },
  });
  const classes = [...new Map(enrolments.map((e) => [e.class.id, { id: e.class.id, name: e.class.name }])).values()];
  const requested = typeof searchParams?.classId === "string" ? searchParams.classId : null;
  const initialClassId = classes.some((c) => c.id === requested) ? requested : null;

  return (
    <section className="overflow-hidden rounded-xl border border-brand-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <NotebookPen size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-foreground">Notes</h1>
          <p className="text-xs text-muted">General class notes and lecture notes from your teachers.</p>
        </div>
      </header>
      <div className="p-3">
        <StudentNotesClient classes={classes} initialClassId={initialClassId} />
      </div>
    </section>
  );
}
