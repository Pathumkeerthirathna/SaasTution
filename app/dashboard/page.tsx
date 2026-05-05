import { cookies } from "next/headers";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  Users,
  Radio,
  CalendarDays,
  FileText,
  ClipboardList,
  HelpCircle,
  MessageSquare,
  GraduationCap,
  CheckCircle2,
  Clock,
  XCircle,
  ArrowRight,
} from "lucide-react";

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
    paperSupportMessages,
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
    prisma.paperSupportMessage.findMany({
      where: {
        teacherId: teacher.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 6,
      select: {
        id: true,
        message: true,
        createdAt: true,
        class: {
          select: {
            name: true,
          },
        },
        student: {
          select: {
            name: true,
            registrationNumber: true,
          },
        },
        item: {
          select: {
            title: true,
          },
        },
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
    <div className="flex w-full flex-col gap-6 pb-6">
      {/* ── Welcome hero ── */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 p-6 text-white shadow-panel sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-8 right-24 h-28 w-28 rounded-full bg-white/5" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-200">Teacher Dashboard</p>
            <h1 className="mt-2 text-2xl font-bold sm:text-3xl">Welcome back, {teacher.name.split(" ")[0]}</h1>
            <p className="mt-1.5 text-sm text-brand-200">Live overview of your classes, activity, and upcoming work.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Classes",  value: classCount,        icon: BookOpen },
              { label: "Students", value: activeStudentCount, icon: Users },
              { label: "Live Now", value: activeSessionCount, icon: Radio },
              { label: "Today",    value: lecturesTodayCount, icon: CalendarDays },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-white backdrop-blur-sm transition hover:bg-white/15">
                <div className="flex items-center gap-1.5">
                  <Icon size={12} className="opacity-70" />
                  <p className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{label}</p>
                </div>
                <p className="mt-1 text-2xl font-bold">{formatNumber(value)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stat cards ── */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Lectures",          value: lectureCount,    helper: "Across all classes",     icon: GraduationCap, bg: "bg-violet-50",  iconCls: "bg-violet-100 text-violet-600", valCls: "text-violet-700", border: "border-violet-200" },
          { label: "Notes & Materials", value: noteCount,       helper: "Published resources",    icon: FileText,      bg: "bg-sky-50",     iconCls: "bg-sky-100 text-sky-600",       valCls: "text-sky-700",    border: "border-sky-200"    },
          { label: "Assignments",       value: assignmentCount, helper: "Total records",          icon: ClipboardList, bg: "bg-amber-50",   iconCls: "bg-amber-100 text-amber-600",   valCls: "text-amber-700",  border: "border-amber-200"  },
          { label: "Quizzes",           value: quizCount,       helper: "Assessment units",       icon: HelpCircle,    bg: "bg-emerald-50", iconCls: "bg-emerald-100 text-emerald-600",valCls: "text-emerald-700",border: "border-emerald-200"},
        ].map(({ label, value, helper, icon: Icon, bg, iconCls, valCls, border }) => (
          <article key={label} className={`relative overflow-hidden rounded-2xl border ${border} ${bg} p-5 shadow-card transition-all duration-200 hover:-translate-y-[1px] hover:shadow-md`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted">{label}</p>
                <p className={`mt-2 text-3xl font-bold ${valCls}`}>{formatNumber(value)}</p>
                <p className="mt-1.5 text-xs text-muted">{helper}</p>
              </div>
              <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${iconCls}`}>
                <Icon size={20} />
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* ── Upcoming events + Communication ── */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        {/* Upcoming events */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
            <h2 className="font-bold text-foreground">Upcoming events</h2>
            <Link href="/dashboard/lectures" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="p-5">
            {upcomingEvents.length === 0 ? (
              <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">
                No upcoming lectures, deadlines, or active sessions in the next 14 days.
              </p>
            ) : (
              <div className="space-y-2.5">
                {upcomingEvents.map((event) => (
                  <Link
                    key={`${event.type}-${event.id}`}
                    href={event.href}
                    className="flex items-start justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/50 px-4 py-3 transition hover:border-brand-300 hover:bg-brand-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{event.title}</p>
                      <p className="mt-0.5 text-xs text-muted">{event.secondary}</p>
                      <p className="mt-1 text-xs text-muted">{formatCompactDateTime(event.when)} · {buildRelativeLabel(event.when)}</p>
                    </div>
                    <span className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getEventTone(event.type)}`}>
                      {getEventLabel(event.type)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </article>

        {/* Communication insights */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
            <h2 className="font-bold text-foreground">Communication insights</h2>
            <p className="mt-0.5 text-xs text-muted">Message pipeline from your classes</p>
          </div>
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                  <MessageSquare size={16} />
                </div>
                <p className="text-sm font-medium text-foreground">Total messages</p>
              </div>
              <p className="text-2xl font-bold text-brand-700">{formatNumber(messageCount)}</p>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-center">
                <CheckCircle2 size={14} className="mx-auto text-emerald-600" />
                <p className="mt-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700">Sent</p>
                <p className="mt-1 text-xl font-bold text-emerald-800">{formatNumber(deliveryCountByStatus.SENT)}</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-center">
                <Clock size={14} className="mx-auto text-amber-600" />
                <p className="mt-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-700">Queued</p>
                <p className="mt-1 text-xl font-bold text-amber-800">{formatNumber(deliveryCountByStatus.QUEUED)}</p>
              </div>
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-center">
                <XCircle size={14} className="mx-auto text-rose-600" />
                <p className="mt-1.5 text-[11px] font-bold uppercase tracking-wide text-rose-700">Failed</p>
                <p className="mt-1 text-xl font-bold text-rose-800">{formatNumber(deliveryCountByStatus.FAILED)}</p>
              </div>
            </div>
            <p className="text-[11px] text-muted">Data reflects current database state.</p>
          </div>
        </article>
      </section>

      {/* ── Profile + Account ── */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted">Profile</h2>
          </div>
          <div className="flex items-center gap-4 px-5 py-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-base font-bold text-white flex-shrink-0">
              {teacher.name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
            </div>
            <div>
              <p className="font-semibold text-foreground">{teacher.name}</p>
              <p className="text-sm text-muted">{teacher.email}</p>
            </div>
          </div>
        </article>
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted">Account Created</h2>
          </div>
          <div className="px-5 py-4">
            <p className="font-semibold text-foreground">{teacher.createdAt.toLocaleDateString()}</p>
            <p className="mt-1 text-xs text-muted font-mono">{teacher.id}</p>
          </div>
        </article>
      </section>

      {/* ── Paper late messages ── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
          <div>
            <h2 className="font-bold text-foreground">Paper late reasons from students</h2>
            <p className="mt-0.5 text-xs text-muted">Messages sent when students miss paper submission deadlines</p>
          </div>
          <Link href="/dashboard/messages" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
            View all <ArrowRight size={12} />
          </Link>
        </div>
        <div className="p-5">
          {paperSupportMessages.length === 0 ? (
            <p className="rounded-xl border border-dashed border-amber-200 bg-amber-50 px-4 py-4 text-sm text-muted">
              No late-reason messages yet.
            </p>
          ) : (
            <div className="space-y-3">
              {paperSupportMessages.map((msg) => (
                <article key={msg.id} className="rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {msg.student.name}
                      {msg.student.registrationNumber ? (
                        <span className="ml-1.5 text-xs font-normal text-muted">({msg.student.registrationNumber})</span>
                      ) : null}
                    </p>
                    <time className="text-xs text-muted">{new Date(msg.createdAt).toLocaleString()}</time>
                  </div>
                  <p className="mt-1 text-xs text-brand-600 font-medium">{msg.class.name} · {msg.item.title}</p>
                  <p className="mt-2 text-sm text-foreground whitespace-pre-line">{msg.message}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Quick actions ── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
          <h2 className="font-bold text-foreground">Quick actions</h2>
        </div>
        <div className="flex flex-wrap gap-3 p-5">
          <Link href="/dashboard/classes"  className="btn-primary"><BookOpen size={14} /> Manage classes</Link>
          <Link href="/dashboard/students" className="btn-primary"><Users size={14} /> Manage students</Link>
          <Link href="/dashboard/messages" className="btn-primary"><MessageSquare size={14} /> Class messages</Link>
          <Link href="/dashboard/lectures" className="btn-primary"><GraduationCap size={14} /> Manage lectures</Link>
          <Link href="/dashboard/sessions" className="btn-primary"><Radio size={14} /> Live sessions</Link>
          <Link href="/guardian/login"     className="btn-secondary">Guardian portal</Link>
          <Link href="/"                   className="btn-secondary">Back to home</Link>
        </div>
      </section>
    </div>
  );
}
