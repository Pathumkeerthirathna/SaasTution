import "server-only";

import { Radio, Video } from "lucide-react";

// Only the component itself comes from the client module; the texts come from the plain module.
import { StudentYouTubeClient } from "@/components/student-portal/recordings/student-youtube-client";
import { STUDENT_YOUTUBE_TEXT, type StudentYouTubeKind } from "@/components/student-portal/recordings/student-youtube-text";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";

/**
 * The body of the student Recordings > Live Recordings and YouTube Live
 * Sessions pages (one server component, two routes).
 *
 * The class list is read here, on the server, for the signed-in student only:
 * ACTIVE enrolments in ACTIVE classes (the classes the YouTube APIs serve).
 * `?classId=` only pre-selects a class when it is one of these; anything else
 * is ignored. Every request re-checks enrolment, visibility and access.
 */
export async function StudentYouTubePage({ kind, searchParams }: { kind: StudentYouTubeKind; searchParams?: { classId?: string | string[] } }) {
  const session = await requireStudentSession();

  const enrolments = await prisma.classStudent.findMany({
    where: { studentId: session.studentId, isActive: true, class: { status: 0 } },
    select: { class: { select: { id: true, name: true } } },
    orderBy: { class: { name: "asc" } },
  });
  const classes = [...new Map(enrolments.map((e) => [e.class.id, { id: e.class.id, name: e.class.name }])).values()];
  const requested = typeof searchParams?.classId === "string" ? searchParams.classId : null;
  const initialClassId = classes.some((c) => c.id === requested) ? requested : null;
  const text = STUDENT_YOUTUBE_TEXT[kind];
  const Icon = kind === "recordings" ? Video : Radio;

  return (
    <section className="overflow-hidden rounded-xl border border-brand-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
          <Icon size={16} />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-foreground">{text.title}</h1>
          <p className="text-xs text-muted">{text.description}</p>
        </div>
      </header>
      <div className="p-3">
        <StudentYouTubeClient kind={kind} classes={classes} initialClassId={initialClassId} />
      </div>
    </section>
  );
}
