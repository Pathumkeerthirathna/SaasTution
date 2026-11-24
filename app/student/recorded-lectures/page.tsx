import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, ChevronRight, Video } from "lucide-react";

import { ClassRecordingsClient } from "@/components/student-portal/recorded-lectures/class-recordings-client";
import { classRecordingsHref } from "@/components/student-portal/recorded-lectures/recording-helpers";
import { requireStudentSession } from "@/lib/auth-session";
import { loadClassRecordings, loadStudentRecordingClasses } from "@/services/recorded-lecture-student-pages";

export const dynamic = "force-dynamic";

/*
 * Student Recorded Lectures (RL-5.1).
 *   /student/recorded-lectures            -> the student's active classes
 *   /student/recorded-lectures?classId=X  -> that class's recorded lectures
 * Data is loaded here on the server (no client request for the first page);
 * every recording comes through the RL-4.2 access filter.
 */

type PageProps = { searchParams: { [key: string]: string | string[] | undefined } };

function Shell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-brand-200 bg-white shadow-card">
      <header className="flex items-center gap-2.5 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <Video size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-foreground">Recorded Lectures</h1>
          <p className="break-words text-xs text-muted">{subtitle}</p>
        </div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Unavailable() {
  return (
    <Shell subtitle="Recorded lectures">
      <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Recorded lectures are temporarily unavailable. Please try again later.
      </p>
    </Shell>
  );
}

export default async function StudentRecordedLecturesPage({ searchParams }: PageProps) {
  const session = await requireStudentSession();
  const classId = typeof searchParams.classId === "string" ? searchParams.classId : null;

  if (classId !== null) {
    const page = await loadClassRecordings(session.studentId, classId);
    if (!page.ok) {
      if (page.reason === "UNAVAILABLE") return <Unavailable />;
      notFound();
    }
    return (
      <Shell subtitle={page.class.name}>
        <ClassRecordingsClient
          // Another class is a fresh client: nothing of the previous class's lists or requests is kept.
          key={page.class.id}
          classInfo={page.class}
          initialGeneral={page.general}
          initialRecordings={page.recordedLectures}
          initialNextCursor={page.nextCursor}
        />
      </Shell>
    );
  }

  const classes = await loadStudentRecordingClasses(session.studentId);
  return (
    <Shell subtitle="Choose a class to see its recorded lectures.">
      {classes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          You are not enrolled in any active classes.
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {classes.map((cls) => (
            <li key={cls.id}>
              <Link
                href={classRecordingsHref(cls.id)}
                className="flex min-h-[56px] items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm hover:border-emerald-300 hover:bg-emerald-50/60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                  <BookOpen size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 break-words text-sm font-semibold text-slate-800">{cls.name}</span>
                <ChevronRight size={16} className="shrink-0 text-slate-400" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
