import Link from "next/link";

import { Panel, StatusBadge } from "@/components/student-portal/student-ui";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function formatSessionTime(startedAt: Date, schedule: string) {
  return `${startedAt.toLocaleString()} • ${schedule}`;
}

export default async function StudentLiveClassesPage() {
  const studentSession = await requireStudentSession();

  const liveSessions = await prisma.classSession.findMany({
    where: {
      isActive: true,
      class: {
        status: 0,
        students: {
          some: {
            studentId: studentSession.studentId,
            isActive: true,
          },
        },
      },
      OR: [{ lectureId: null }, { lecture: { status: 0 } }],
    },
    orderBy: {
      startedAt: "desc",
    },
    select: {
      id: true,
      startedAt: true,
      class: {
        select: {
          name: true,
          schedule: true,
          teacher: {
            select: {
              name: true,
            },
          },
        },
      },
      lecture: {
        select: {
          title: true,
        },
      },
    },
  });

  return (
    <Panel title="Live Classes" subtitle="Classes currently active and available to join.">
      {liveSessions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
          No live classes are running for your enrolled classes right now.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {liveSessions.map((session) => (
            <article key={session.id} className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                  <h3 className="text-base font-semibold text-slate-900">{session.class.name}</h3>
                  <p className="mt-1 text-sm text-slate-600">Teacher: {session.class.teacher.name}</p>
                  <p className="text-sm text-slate-600">{formatSessionTime(session.startedAt, session.class.schedule)}</p>
                  {session.lecture ? <p className="text-sm text-slate-600">Lecture: {session.lecture.title}</p> : null}
              </div>
                <StatusBadge label="Live" tone="live" />
            </div>
            <div className="mt-4">
                <Link
                  href={`/session/join?sessionId=${session.id}&role=student&studentId=${studentSession.studentId}`}
                  className="inline-flex rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
                >
                  Join now
                </Link>
            </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
