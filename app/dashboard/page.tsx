import { cookies } from "next/headers";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type UpcomingEvent = {
  id: string;
  type: "LECTURE" | "ASSIGNMENT" | "LIVE_SESSION";
  title: string;
  when: Date;
  secondary: string;
  href: string;
};

function formatCompactDateTime(value: Date) {
  return value.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildRelativeLabel(value: Date) {
  const now = Date.now();
  const diffMs = value.getTime() - now;
  const absMinutes = Math.round(Math.abs(diffMs) / (1000 * 60));

  if (absMinutes < 1) {
    return "now";
  }

  const units: Array<{ limit: number; divisor: number; name: string }> = [
    { limit: 60, divisor: 1, name: "minute" },
    { limit: 60 * 24, divisor: 60, name: "hour" },
    { limit: 60 * 24 * 30, divisor: 60 * 24, name: "day" },
  ];

  const minutes = absMinutes;

  for (const unit of units) {
    if (minutes < unit.limit) {
      const amount = Math.max(1, Math.round(minutes / unit.divisor));
      const suffix = amount === 1 ? unit.name : `${unit.name}s`;
      return diffMs >= 0 ? `in ${amount} ${suffix}` : `${amount} ${suffix} ago`;
    }
  }

  const months = Math.max(1, Math.round(minutes / (60 * 24 * 30)));
  return diffMs >= 0 ? `in ${months} month${months === 1 ? "" : "s"}` : `${months} month${months === 1 ? "" : "s"} ago`;
}

function getEventTone(type: UpcomingEvent["type"]) {
  if (type === "LIVE_SESSION") {
    return "bg-rose-100 text-rose-700";
  }

  if (type === "ASSIGNMENT") {
    return "bg-amber-100 text-amber-700";
  }

  return "bg-blue-100 text-blue-700";
}

function getEventLabel(type: UpcomingEvent["type"]) {
  if (type === "LIVE_SESSION") {
    return "Live";
  }

  if (type === "ASSIGNMENT") {
    return "Deadline";
  }

  return "Lecture";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

export default async function DashboardPage() {
  noStore();

  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const session = await verifyAuthToken(token);

  if (!session) {
    redirect("/login");
  }

  if (session.role === "ADMIN") {
    redirect("/dashboard/admin");
  }

  if (session.role !== "TEACHER") {
    redirect("/login");
  }

  const teacher = await prisma.teacher.findUnique({
    where: {
      id: session.sub,
    },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
    },
  });

  if (!teacher) {
    redirect("/login");
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const next14Days = new Date(now);
  next14Days.setDate(next14Days.getDate() + 14);

  const [
    classCount,
    lectureCount,
    noteCount,
    assignmentCount,
    quizCount,
    messageCount,
    activeSessionCount,
    classesWithStudents,
    upcomingLectures,
    upcomingAssignments,
    activeSessions,
    deliveryStats,
  ] = await Promise.all([
    prisma.class.count({
      where: {
        teacherId: teacher.id,
      },
    }),
    prisma.lecture.count({
      where: {
        class: {
          teacherId: teacher.id,
        },
      },
    }),
    prisma.note.count({
      where: {
        lecture: {
          class: {
            teacherId: teacher.id,
          },
        },
      },
    }),
    prisma.assignment.count({
      where: {
        lecture: {
          class: {
            teacherId: teacher.id,
          },
        },
      },
    }),
    prisma.quiz.count({
      where: {
        lecture: {
          class: {
            teacherId: teacher.id,
          },
        },
      },
    }),
    prisma.message.count({
      where: {
        class: {
          teacherId: teacher.id,
        },
      },
    }),
    prisma.classSession.count({
      where: {
        isActive: true,
        class: {
          teacherId: teacher.id,
        },
      },
    }),
    prisma.class.findMany({
      where: {
        teacherId: teacher.id,
      },
      select: {
        students: {
          where: {
            isActive: true,
          },
          select: {
            studentId: true,
          },
        },
      },
    }),
    prisma.lecture.findMany({
      where: {
        class: {
          teacherId: teacher.id,
        },
        date: {
          gte: now,
          lte: next14Days,
        },
      },
      orderBy: {
        date: "asc",
      },
      take: 6,
      select: {
        id: true,
        title: true,
        date: true,
        class: {
          select: {
            name: true,
          },
        },
      },
    }),
    prisma.assignment.findMany({
      where: {
        dueDate: {
          gte: now,
          lte: next14Days,
        },
        lecture: {
          class: {
            teacherId: teacher.id,
          },
        },
      },
      orderBy: {
        dueDate: "asc",
      },
      take: 6,
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: {
          select: {
            title: true,
            class: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    }),
    prisma.classSession.findMany({
      where: {
        isActive: true,
        class: {
          teacherId: teacher.id,
        },
      },
      orderBy: {
        startedAt: "desc",
      },
      take: 4,
      select: {
        id: true,
        startedAt: true,
        class: {
          select: {
            name: true,
          },
        },
        lecture: {
          select: {
            title: true,
          },
        },
      },
    }),
    prisma.messageDelivery.groupBy({
      by: ["status"],
      where: {
        message: {
          class: {
            teacherId: teacher.id,
          },
        },
      },
      _count: {
        status: true,
      },
    }),
  ]);

  const uniqueStudentIds = new Set(
    classesWithStudents.flatMap((classroom) => classroom.students.map((enrollment) => enrollment.studentId))
  );

  const activeStudentCount = uniqueStudentIds.size;

  const deliveryCountByStatus = {
    QUEUED: 0,
    SENT: 0,
    FAILED: 0,
  };

  for (const row of deliveryStats) {
    deliveryCountByStatus[row.status] = row._count.status;
  }

  const upcomingEvents: UpcomingEvent[] = [
    ...upcomingLectures.map((lecture) => ({
      id: lecture.id,
      type: "LECTURE" as const,
      title: lecture.title,
      when: lecture.date,
      secondary: lecture.class.name,
      href: "/dashboard/lectures",
    })),
    ...upcomingAssignments.map((assignment) => ({
      id: assignment.id,
      type: "ASSIGNMENT" as const,
      title: assignment.title,
      when: assignment.dueDate,
      secondary: `${assignment.lecture.class.name} • ${assignment.lecture.title}`,
      href: "/dashboard/lectures",
    })),
    ...activeSessions.map((sessionItem) => ({
      id: sessionItem.id,
      type: "LIVE_SESSION" as const,
      title: sessionItem.lecture?.title ?? "Live class in progress",
      when: sessionItem.startedAt,
      secondary: sessionItem.class.name,
      href: "/dashboard/sessions",
    })),
  ]
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 10);

  const lecturesTodayCount = await prisma.lecture.count({
    where: {
      class: {
        teacherId: teacher.id,
      },
      date: {
        gte: todayStart,
        lt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
      },
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col py-4">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Teacher Dashboard</p>
            <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Welcome back, {teacher.name}</h1>
            <p className="mt-2 text-sm text-muted">Live overview of classes, learning activity, and upcoming work.</p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <article className="rounded-2xl border border-black/10 px-4 py-3 dark:border-white/10">
              <p className="text-xs uppercase tracking-wide text-muted">Classes</p>
              <p className="mt-1 text-xl font-semibold">{formatNumber(classCount)}</p>
            </article>
            <article className="rounded-2xl border border-black/10 px-4 py-3 dark:border-white/10">
              <p className="text-xs uppercase tracking-wide text-muted">Students</p>
              <p className="mt-1 text-xl font-semibold">{formatNumber(activeStudentCount)}</p>
            </article>
            <article className="rounded-2xl border border-black/10 px-4 py-3 dark:border-white/10">
              <p className="text-xs uppercase tracking-wide text-muted">Live now</p>
              <p className="mt-1 text-xl font-semibold">{formatNumber(activeSessionCount)}</p>
            </article>
            <article className="rounded-2xl border border-black/10 px-4 py-3 dark:border-white/10">
              <p className="text-xs uppercase tracking-wide text-muted">Today</p>
              <p className="mt-1 text-xl font-semibold">{formatNumber(lecturesTodayCount)}</p>
            </article>
          </div>
        </div>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Lectures</p>
          <p className="mt-2 text-3xl font-semibold">{formatNumber(lectureCount)}</p>
          <p className="mt-1 text-xs text-muted">Across all active classes</p>
        </article>

        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Notes & Materials</p>
          <p className="mt-2 text-3xl font-semibold">{formatNumber(noteCount)}</p>
          <p className="mt-1 text-xs text-muted">Published resources</p>
        </article>

        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Assignments</p>
          <p className="mt-2 text-3xl font-semibold">{formatNumber(assignmentCount)}</p>
          <p className="mt-1 text-xs text-muted">Total assignment records</p>
        </article>

        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Quizzes</p>
          <p className="mt-2 text-3xl font-semibold">{formatNumber(quizCount)}</p>
          <p className="mt-1 text-xs text-muted">Assessment units created</p>
        </article>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_1fr]">
        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Upcoming events</h2>
            <Link href="/dashboard/lectures" className="text-xs font-semibold text-brand-700 hover:underline">
              Open lecture manager
            </Link>
          </div>

          {upcomingEvents.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-black/15 px-4 py-3 text-sm text-muted dark:border-white/15">
              No upcoming lectures, deadlines, or active sessions in the next 14 days.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {upcomingEvents.map((event) => (
                <Link
                  key={`${event.type}-${event.id}`}
                  href={event.href}
                  className="block rounded-xl border border-black/10 px-4 py-3 transition hover:border-black/30 hover:bg-black/[0.02] dark:border-white/10 dark:hover:border-white/25 dark:hover:bg-white/[0.02]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{event.title}</p>
                      <p className="mt-1 text-xs text-muted">{event.secondary}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getEventTone(event.type)}`}>
                      {getEventLabel(event.type)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted">{formatCompactDateTime(event.when)} • {buildRelativeLabel(event.when)}</p>
                </Link>
              ))}
            </div>
          )}
        </article>

        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <h2 className="text-base font-semibold">Communication insights</h2>
          <p className="mt-1 text-sm text-muted">Message pipeline status from your classes.</p>

          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-black/10 px-4 py-3 dark:border-white/10">
              <p className="text-xs uppercase tracking-wide text-muted">Messages sent</p>
              <p className="mt-1 text-2xl font-semibold">{formatNumber(messageCount)}</p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Sent</p>
                <p className="mt-1 text-xl font-semibold text-emerald-800">{formatNumber(deliveryCountByStatus.SENT)}</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Queued</p>
                <p className="mt-1 text-xl font-semibold text-amber-800">{formatNumber(deliveryCountByStatus.QUEUED)}</p>
              </div>
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700">Failed</p>
                <p className="mt-1 text-xl font-semibold text-red-800">{formatNumber(deliveryCountByStatus.FAILED)}</p>
              </div>
            </div>

            <div className="rounded-xl border border-black/10 px-4 py-3 text-xs text-muted dark:border-white/10">
              Data refreshes on page load and reflects the current database state.
            </div>
          </div>
        </article>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Profile</h2>
          <p className="mt-3 text-base font-medium">{teacher.name}</p>
          <p className="text-sm text-muted">{teacher.email}</p>
        </article>

        <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Account Created</h2>
          <p className="mt-3 text-base font-medium">{teacher.createdAt.toLocaleString()}</p>
          <p className="text-sm text-muted">Teacher ID: {teacher.id}</p>
        </article>
      </section>

      <div className="mt-6">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/dashboard/classes"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Manage classes
          </Link>
          <Link
            href="/dashboard/students"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Manage students
          </Link>
          <Link
            href="/dashboard/messages"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Class messages
          </Link>
          <Link
            href="/dashboard/lectures"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Manage lectures
          </Link>
          <Link
            href="/dashboard/sessions"
            className="inline-flex rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Live sessions
          </Link>
          <Link
            href="/guardian/login"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Guardian portal
          </Link>
          <Link
            href="/"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
