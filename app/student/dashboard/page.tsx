import Link from "next/link";
import { redirect } from "next/navigation";

import {
  getSummaryStats,
  upcomingClassesSeed,
} from "@/components/student-portal/student-data";
import { Panel, StatusBadge, SummaryCard } from "@/components/student-portal/student-ui";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { verifySessionInviteToken } from "@/lib/session-invite";

type StudentDashboardPageProps = {
  searchParams?: {
    invite?: string;
  };
};

export default async function StudentDashboardPage({ searchParams }: StudentDashboardPageProps) {
  const inviteToken = searchParams?.invite?.trim();
  const studentSession = await requireStudentSession();

  if (inviteToken) {
    const invitePayload = await verifySessionInviteToken(inviteToken);

    if (invitePayload && invitePayload.studentId === studentSession.studentId) {
      redirect(`/session/join?invite=${encodeURIComponent(inviteToken)}`);
    }
  }

  const liveSessions = await prisma.classSession.findMany({
    where: {
      isActive: true,
      class: {
        students: {
          some: {
            studentId: studentSession.studentId,
            isActive: true,
          },
        },
      },
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

  const summary = getSummaryStats();

  return (
    <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard title="Total Classes" value={String(summary.totalClasses)} helper="All enrolled classes" />
        <SummaryCard title="Upcoming Classes" value={String(summary.upcomingClasses)} helper="Scheduled next sessions" />
        <SummaryCard title="Live Classes" value={String(liveSessions.length)} helper="Happening right now" />
        <SummaryCard title="Pending Assignments" value={String(summary.pendingAssignments)} helper="Need attention" />
        <SummaryCard title="Upcoming Quizzes" value={String(summary.upcomingQuizzes)} helper="Prepare ahead" />
      </section>

      <Panel
        title="Ongoing Classes"
        subtitle="Join your active live classes now."
        actions={<StatusBadge label="High Priority" tone="live" />}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {liveSessions.length === 0 ? (
            <article className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-4 text-sm text-slate-600">
              No live classes are running right now.
            </article>
          ) : (
            liveSessions.map((item) => (
              <article key={item.id} className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">{item.class.name}</h3>
                    <p className="mt-1 text-sm text-slate-600">Teacher: {item.class.teacher.name}</p>
                    <p className="text-sm text-slate-600">Started: {new Date(item.startedAt).toLocaleString()}</p>
                    {item.lecture ? <p className="text-sm text-slate-600">Lecture: {item.lecture.title}</p> : null}
                  </div>
                  <StatusBadge label="Live" tone="live" />
                </div>
                <div className="mt-4">
                  <Link
                    href={`/session/join?sessionId=${item.id}&role=student&studentId=${studentSession.studentId}`}
                    className="inline-flex items-center justify-center rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Join Now
                  </Link>
                </div>
              </article>
            ))
          )}
        </div>
      </Panel>

      <Panel title="Upcoming Classes" subtitle="Your next scheduled sessions.">
        <div className="space-y-3">
          {upcomingClassesSeed.map((item) => (
            <article key={`${item.className}-${item.dateTime}`} className="rounded-xl border border-brand-200 bg-white p-3">
              <h3 className="font-medium text-slate-900">{item.className}</h3>
              <p className="mt-1 text-sm text-slate-600">{item.dateTime}</p>
              <p className="text-sm text-slate-600">Teacher: {item.teacherName}</p>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}
