import Link from "next/link";
import { redirect } from "next/navigation";
import { Radio, CalendarDays, BookOpen, ClipboardList, ArrowRight } from "lucide-react";

import {
  getSummaryStats,
  upcomingClassesSeed,
} from "@/components/student-portal/student-data";
import { PaperCountdownList } from "@/components/student-portal/paper-countdown-list";
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

  const now = new Date();

  const upcomingPaperItems = await prisma.materialBundleItem.findMany({
    where: {
      type: "PAPER",
      paperStartAt: { not: null },
      bundle: {
        status: "SENT",
        recipients: {
          some: {
            studentId: studentSession.studentId,
            willReceive: true,
          },
        },
        class: {
          students: {
            some: {
              studentId: studentSession.studentId,
              isActive: true,
            },
          },
        },
      },
    },
    select: {
      id: true,
      title: true,
      paperStartAt: true,
      bundle: {
        select: {
          title: true,
          class: {
            select: {
              name: true,
              teacher: {
                select: {
                  paperConfig: {
                    select: {
                      countdownLeadMinutes: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { paperStartAt: "asc" },
    take: 20,
  });

  const countdownItems = upcomingPaperItems
    .filter((item): item is typeof item & { paperStartAt: Date } => !!item.paperStartAt)
    .filter((item) => {
      const leadMinutes = item.bundle.class.teacher.paperConfig?.countdownLeadMinutes ?? 30;
      const countdownStart = new Date(item.paperStartAt.getTime() - leadMinutes * 60 * 1000);
      return now >= countdownStart && now < item.paperStartAt;
    })
    .map((item) => ({
      itemId: item.id,
      itemTitle: item.title,
      className: item.bundle.class.name,
      bundleTitle: item.bundle.title,
      paperStartAt: item.paperStartAt.toISOString(),
    }));

  return (
    <>
      <PaperCountdownList items={countdownItems} />

      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 px-6 py-6 text-white shadow-panel sm:px-8 sm:py-7">
        <div className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute bottom-0 right-24 h-20 w-20 rounded-full bg-white/10" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-200">Student Dashboard</p>
            <h1 className="mt-2 text-2xl font-bold sm:text-3xl">Your learning command center</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-brand-200">Track classes, join live sessions quickly, and stay ahead on assignments and quizzes.</p>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <Link href="/student/classes" className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/15">
              <BookOpen size={13} className="mx-auto mb-1" />
              Classes
            </Link>
            <Link href="/student/assignments" className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/15">
              <ClipboardList size={13} className="mx-auto mb-1" />
              Tasks
            </Link>
            <Link href="/student/live-classes" className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/15">
              <Radio size={13} className="mx-auto mb-1" />
              Live
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard title="Total Classes"       value={String(summary.totalClasses)}       helper="All enrolled classes"    icon="book"       color="blue"    />
        <SummaryCard title="Upcoming Classes"    value={String(summary.upcomingClasses)}    helper="Scheduled next sessions" icon="calendar"   color="sky"     />
        <SummaryCard title="Live Classes"        value={String(liveSessions.length)}        helper="Happening right now"     icon="radio"      color="emerald" />
        <SummaryCard title="Pending Assignments" value={String(summary.pendingAssignments)} helper="Need attention"          icon="assignment" color="amber"   />
        <SummaryCard title="Upcoming Quizzes"   value={String(summary.upcomingQuizzes)}    helper="Prepare ahead"           icon="quiz"       color="violet"  />
      </section>

      <Panel
        title="Ongoing Classes"
        subtitle="Join your active live classes now."
        actions={<StatusBadge label="High Priority" tone="live" />}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {liveSessions.length === 0 ? (
            <article className="col-span-2 rounded-xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-muted">
              No live classes are running right now.
            </article>
          ) : (
            liveSessions.map((item) => (
              <article key={item.id} className="overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-foreground">{item.class.name}</h3>
                    <p className="mt-1 text-xs text-muted">Teacher: {item.class.teacher.name}</p>
                    <p className="text-xs text-muted">Started: {new Date(item.startedAt).toLocaleString()}</p>
                    {item.lecture ? <p className="mt-1 text-xs font-medium text-emerald-700">{item.lecture.title}</p> : null}
                  </div>
                  <StatusBadge label="Live" tone="live" />
                </div>
                <div className="mt-4">
                  <Link
                    href={`/session/join?sessionId=${item.id}&role=student&studentId=${studentSession.studentId}`}
                    className="btn-primary inline-flex items-center gap-1.5"
                  >
                    <Radio size={14} /> Join now
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
            <article key={`${item.className}-${item.dateTime}`} className="flex items-center justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/50 px-4 py-3 transition hover:border-brand-200 hover:bg-brand-50">
              <div>
                <h3 className="font-semibold text-foreground">{item.className}</h3>
                <p className="mt-0.5 text-xs text-muted">Teacher: {item.teacherName}</p>
              </div>
              <p className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-brand-700"><CalendarDays size={12} /> {item.dateTime}</p>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}
