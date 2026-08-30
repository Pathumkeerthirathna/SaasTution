import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  Radio,
  ClipboardList,
  MessageSquare,
  CheckCircle2,
  ArrowRight,
  Play,
  DollarSign,
  Bell,
  BarChart2,
  FileText,
  Package,
  UserCheck,
  BookMarked,
} from "lucide-react";
import { Weekday } from "@prisma/client";

import { requireStudentSession } from "@/lib/auth-session";
import { getCurrentMonthKey, getPaymentDueDate } from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";
import { verifySessionInviteToken } from "@/lib/session-invite";
import { PaperCountdownList } from "@/components/student-portal/paper-countdown-list";

// helpers

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

function formatElapsed(startedAt: Date): string {
  const mins = Math.floor((Date.now() - startedAt.getTime()) / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

type SearchParams = { invite?: string };

export default async function StudentDashboardPage({ searchParams }: { searchParams?: SearchParams }) {
  noStore();

  const studentSession = await requireStudentSession();
  const studentId = studentSession.studentId;

  const inviteToken = searchParams?.invite?.trim();
  if (inviteToken) {
    const invitePayload = await verifySessionInviteToken(inviteToken);
    if (invitePayload && invitePayload.studentId === studentId) {
      redirect(`/session/join?invite=${encodeURIComponent(inviteToken)}`);
    }
  }

  const now = new Date();
  const currentMonthKey = getCurrentMonthKey();
  const [currentYearNum, currentMonthNum] = currentMonthKey
    .split("-")
    .map(Number);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayWeekday = WEEKDAY_NAMES[now.getDay()] as Weekday;

  const [
    enrolledClasses,
    liveSessions,
    todaySchedules,
    pendingAssignments,
      /* submittedAssignmentIds unused */,
    recentQuizzes,
    recentNotes,
    materialBundles,
    recentMessages,
    paperSupportMessages,
    paymentsThisMonth,
    attendanceRecords,
    attendanceTotalSessions,
    upcomingPaperItems,
  ] = await Promise.all([

    prisma.classStudent.findMany({
      where: { studentId, isActive: true },
      select: {
        classId: true,
        class: {
          select: {
            id: true,
            name: true,
            monthlyFee: true,
            paymentDueWeek: true,
            teacher: { select: { name: true } },
            schedules: { select: { dayOfWeek: true, startTime: true, endTime: true } },
          },
        },
      },
      orderBy: { assignedAt: "asc" },
    }),

    prisma.classSession.findMany({
      where: {
        isActive: true,
        class: { students: { some: { studentId, isActive: true } } },
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        roomName: true,
        jitsiDomain: true,
        class: { select: { id: true, name: true, teacher: { select: { name: true } } } },
        lecture: { select: { title: true } },
        _count: { select: { attendance: true } },
      },
    }),

    prisma.classSchedule.findMany({
      where: {
        dayOfWeek: todayWeekday,
        class: { students: { some: { studentId, isActive: true } } },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        class: {
          select: {
            id: true,
            name: true,
            teacher: { select: { name: true } },
            sessions: {
              where: { isActive: true },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    }),

    prisma.assignment.findMany({
      where: {
        lecture: { class: { students: { some: { studentId, isActive: true } } } },
        dueDate: { gte: now },
        submissions: { none: { studentId } },
      },
      orderBy: { dueDate: "asc" },
      take: 10,
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: { select: { title: true, class: { select: { name: true } } } },
      },
    }),

    prisma.assignmentSubmission.findMany({
      where: { studentId },
      select: { assignmentId: true, submittedAt: true },
      orderBy: { submittedAt: "desc" },
      take: 20,
    }),

    prisma.quiz.findMany({
      where: { lecture: { class: { students: { some: { studentId, isActive: true } } } } },
      orderBy: { dueDate: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        dueDate: true,
        maxAttempts: true,
        lecture: { select: { class: { select: { name: true } } } },
        submissions: {
          where: { studentId },
          select: { score: true, totalQuestions: true, attemptCount: true, submittedAt: true },
          take: 1,
        },
      },
    }),

    prisma.note.findMany({
      where: { lecture: { class: { students: { some: { studentId, isActive: true } } } } },
      orderBy: { lectureId: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        kind: true,
        fileUrl: true,
        mimeType: true,
        downloadCount: true,
        lecture: { select: { title: true, class: { select: { name: true } } } },
      },
    }),

    prisma.materialBundle.findMany({
      where: {
        status: "SENT",
        recipients: { some: { studentId, willReceive: true } },
      },
      orderBy: { sentAt: "desc" },
      take: 6,
      select: {
        id: true,
        title: true,
        year: true,
        month: true,
        sentAt: true,
        class: { select: { name: true } },
        items: {
          select: {
            id: true,
            type: true,
            title: true,
            fileUrl: true,
            paperStartAt: true,
          },
        },
      },
    }),

    prisma.messageDelivery.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        status: true,
        createdAt: true,
        message: {
          select: {
            content: true,
            class: { select: { name: true } },
          },
        },
      },
    }),

    prisma.paperSupportMessage.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        message: true,
        createdAt: true,
        item: { select: { title: true } },
        class: { select: { name: true } },
      },
    }),

    prisma.classPayment.findMany({
      where: {
        studentId,
        classStudentFee: { year: currentYearNum, month: currentMonthNum },
      },
      select: {
        classId: true,
        status: true,
        amount: true,
        submittedAt: true,
        teacherFeedback: true,
      },
    }),

    prisma.attendance.findMany({
      where: {
        studentId,
        classSession: { class: { students: { some: { studentId, isActive: true } } } },
      },
      orderBy: { joinedAt: "desc" },
      take: 30,
      select: {
        id: true,
        joinedAt: true,
        classSession: {
          select: {
            startedAt: true,
            class: { select: { name: true } },
          },
        },
      },
    }),

    prisma.classSession.count({
      where: {
        class: { students: { some: { studentId, isActive: true } } },
        isActive: false,
      },
    }),

    prisma.materialBundleItem.findMany({
      where: {
        type: "PAPER",
        paperStartAt: { not: null },
        bundle: {
          status: "SENT",
          recipients: { some: { studentId, willReceive: true } },
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
                teacher: { select: { paperConfig: { select: { countdownLeadMinutes: true } } } },
              },
            },
          },
        },
      },
      orderBy: { paperStartAt: "asc" },
      take: 20,
    }),
  ]);

  // derived values

  const enrolledCount = enrolledClasses.length;
  const todayLabel = `${WEEKDAY_LABELS[now.getDay()]}, ${now.toLocaleDateString([], { month: "long", day: "numeric" })}`;

  const todayClassesWithStatus = todaySchedules.map((sch) => {
    const isLive = sch.class.sessions.length > 0;
    const liveSession = liveSessions.find((s) => s.class.id === sch.class.id) ?? null;
    const [eh, em] = sch.endTime.split(":").map(Number);
    const endMs = eh * 60 + em;
    const nowMs = now.getHours() * 60 + now.getMinutes();
    const status: "live" | "upcoming" | "completed" =
      isLive ? "live" : nowMs > endMs ? "completed" : "upcoming";
    return { ...sch, status, liveSession };
  });

  const paymentMap = new Map(paymentsThisMonth.map((p) => [p.classId, p]));
  const paymentDueItems = enrolledClasses.map((entry) => {
    const dueDate = getPaymentDueDate(currentMonthKey, entry.class.paymentDueWeek as 1 | 2 | 3 | 4);
    const payment = paymentMap.get(entry.classId) ?? null;
    const isPastDue = now > dueDate && !payment;
    return {
      classId: entry.classId,
      className: entry.class.name,
      teacherName: entry.class.teacher.name,
      monthlyFee: entry.class.monthlyFee,
      dueDate,
      payment,
      isPastDue,
    };
  });

  const confirmedCount = paymentsThisMonth.filter((p) => p.status === "CONFIRMED").length;
  const pendingPayCount = paymentsThisMonth.filter(
    (p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION"
  ).length;
  const unpaidCount = enrolledCount - confirmedCount - pendingPayCount;

  const attendedCount = attendanceRecords.length;
  const attendancePct =
    attendanceTotalSessions > 0
      ? Math.round((attendedCount / attendanceTotalSessions) * 100)
      : 0;
  const lastAttended = attendanceRecords[0] ?? null;

  const quizScores = recentQuizzes
    .filter((q) => q.submissions.length > 0)
    .map((q) =>
      q.submissions[0].totalQuestions > 0
        ? Math.round((q.submissions[0].score / q.submissions[0].totalQuestions) * 100)
        : 0
    );
  const avgQuizScore =
    quizScores.length > 0
      ? Math.round(quizScores.reduce((s, v) => s + v, 0) / quizScores.length)
      : null;

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

  const quickPrimaryActions = [
    { label: "My Classes",    href: "/student/classes",      Icon: BookOpen      },
    { label: "Assignments",   href: "/student/assignments",  Icon: ClipboardList },
    { label: "Live Sessions", href: "/student/live-classes", Icon: Radio         },
    { label: "Lectures",      href: "/student/lectures",     Icon: BookMarked    },
    { label: "Attendance",    href: "/student/attendance",   Icon: UserCheck     },
    { label: "Messages",      href: "/student/messages",     Icon: MessageSquare },
  ];

  return (
    <>
      <PaperCountdownList items={countdownItems} />

      <div className="flex w-full flex-col gap-6 pb-6">

        {/* 1. Hero */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 p-6 text-white shadow-panel sm:p-8">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/5" />
          <div className="pointer-events-none absolute -bottom-8 right-24 h-28 w-28 rounded-full bg-white/5" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-brand-200">Student Dashboard</p>
              <h1 className="mt-2 text-2xl font-bold sm:text-3xl">
                Welcome back, {studentSession.name.split(" ")[0]}
              </h1>
              <p className="mt-1.5 text-sm text-brand-200">{todayLabel} &middot; Your learning command center.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {[
                  { label: `${enrolledCount} Classes`,              bg: "bg-white/10" },
                  { label: `${liveSessions.length} Live Now`,       bg: liveSessions.length > 0 ? "bg-emerald-500/30" : "bg-white/10" },
                  { label: `${todaySchedules.length} Today`,        bg: "bg-white/10" },
                  { label: `${pendingAssignments.length} Pending`,  bg: pendingAssignments.length > 0 ? "bg-amber-500/30" : "bg-white/10" },
                  { label: unpaidCount > 0 ? `${unpaidCount} Unpaid` : "Payments OK", bg: unpaidCount > 0 ? "bg-red-500/30" : "bg-emerald-500/20" },
                ].map(({ label, bg }) => (
                  <span key={label} className={`rounded-full border border-white/10 px-3 py-1 text-xs font-semibold text-white ${bg}`}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5 lg:min-w-[260px]">
              <Link href="/student/classes"      className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><BookOpen size={13} className="mx-auto mb-1" />Classes</Link>
              <Link href="/student/assignments"  className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><ClipboardList size={13} className="mx-auto mb-1" />Tasks</Link>
              <Link href="/student/live-classes" className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><Radio size={13} className="mx-auto mb-1" />Live</Link>
              <Link href="/student/lectures"     className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><BookMarked size={13} className="mx-auto mb-1" />Lectures</Link>
              <Link href="/student/messages"     className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><MessageSquare size={13} className="mx-auto mb-1" />Messages</Link>
              <Link href="/student/attendance"   className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><UserCheck size={13} className="mx-auto mb-1" />Attendance</Link>
            </div>
          </div>
        </section>

        {/* 2. Live Class NOW */}
        {liveSessions.length > 0 && (
          <section className="rounded-3xl border-2 border-emerald-400 bg-gradient-to-r from-emerald-50 to-white p-5 shadow-card">
            <div className="mb-3 flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
              </span>
              <p className="text-sm font-bold uppercase tracking-widest text-emerald-700">Live Now</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {liveSessions.map((session) => (
                <article key={session.id} className="flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm">
                  <div>
                    <h3 className="text-base font-bold text-foreground">{session.class.name}</h3>
                    <p className="text-xs text-muted">Teacher: {session.class.teacher.name}</p>
                    {session.lecture && <p className="mt-0.5 text-xs font-medium text-emerald-700">{session.lecture.title}</p>}
                    <p className="mt-1 text-[11px] text-muted">Started {formatElapsed(session.startedAt)} ago &middot; {session._count.attendance} joined</p>
                  </div>
                  <Link href={`/session/join?sessionId=${session.id}&role=student&studentId=${studentId}`} className="btn-primary inline-flex items-center gap-1.5 self-start">
                    <Play size={13} /> Join Now
                  </Link>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* 3. Today's Schedule */}
        <section className="rounded-3xl border border-border bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-foreground">Today&apos;s Schedule</h2>
              <p className="text-xs text-muted">{todayLabel}</p>
            </div>
            <Link href="/student/classes" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">All classes <ArrowRight size={12} /></Link>
          </div>
          {todayClassesWithStatus.length === 0 ? (
            <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No classes scheduled for today.</p>
          ) : (
            <div className="space-y-3">
              {todayClassesWithStatus.map((sch) => (
                <article key={sch.id} className="flex items-center justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                  <div>
                    <p className="font-semibold text-foreground">{sch.class.name}</p>
                    <p className="text-xs text-muted">{sch.startTime} &ndash; {sch.endTime} &middot; {sch.class.teacher.name}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {sch.status === "live" && sch.liveSession && (
                      <Link href={`/session/join?sessionId=${sch.liveSession.id}&role=student&studentId=${studentId}`} className="btn-primary inline-flex items-center gap-1 px-3 py-1.5 text-xs">
                        <Radio size={11} /> Join
                      </Link>
                    )}
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${sch.status === "live" ? "bg-emerald-100 text-emerald-700" : sch.status === "completed" ? "bg-zinc-100 text-zinc-500" : "bg-amber-50 text-amber-700"}`}>
                      {sch.status === "live" ? "Live" : sch.status === "completed" ? "Done" : "Upcoming"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* 4. Stat Cards */}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Enrolled Classes",    value: enrolledCount,                                              sub: "Active enrolments",           Icon: BookOpen,      color: "text-brand-600",   bg: "bg-brand-50"   },
            { label: "Pending Assignments", value: pendingAssignments.length,                                  sub: "Due soon",                    Icon: ClipboardList, color: "text-amber-600",   bg: "bg-amber-50"   },
            { label: "Attendance Rate",     value: `${attendancePct}%`,                                        sub: `${attendedCount} sessions`,   Icon: UserCheck,     color: "text-emerald-600", bg: "bg-emerald-50" },
            { label: "Avg Quiz Score",      value: avgQuizScore !== null ? `${avgQuizScore}%` : "N/A",        sub: "Across all quizzes",          Icon: BarChart2,     color: "text-violet-600",  bg: "bg-violet-50"  },
          ].map(({ label, value, sub, Icon, color, bg }) => (
            <article key={label} className="flex items-center gap-4 rounded-2xl border border-border bg-white p-4 shadow-card">
              <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${bg}`}>
                <Icon size={18} className={color} />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">{value}</p>
                <p className="text-xs font-semibold text-foreground">{label}</p>
                <p className="text-[11px] text-muted">{sub}</p>
              </div>
            </article>
          ))}
        </section>

        {/* 5. Assignments + Quizzes */}
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-3xl border border-border bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-bold text-foreground">Pending Assignments</h2>
              <Link href="/student/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">View all <ArrowRight size={12} /></Link>
            </div>
            {pendingAssignments.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-emerald-200 bg-emerald-50 py-6 text-center">
                <CheckCircle2 size={22} className="text-emerald-500" />
                <p className="text-sm font-medium text-emerald-700">All caught up!</p>
                <p className="text-xs text-muted">No pending assignments.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {pendingAssignments.map((a) => {
                  const daysLeft = Math.ceil((a.dueDate.getTime() - now.getTime()) / 86_400_000);
                  const urgent = daysLeft <= 2;
                  return (
                    <article key={a.id} className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 ${urgent ? "border-red-200 bg-red-50" : "border-brand-100 bg-brand-50/40"}`}>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{a.title}</p>
                        <p className="text-xs text-muted">{a.lecture.class.name} &middot; {a.lecture.title}</p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className={`text-xs font-bold ${urgent ? "text-red-600" : "text-amber-600"}`}>{daysLeft === 0 ? "Due today" : `${daysLeft}d left`}</p>
                        <p className="text-[11px] text-muted">{a.dueDate.toLocaleDateString()}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-border bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-bold text-foreground">Quizzes &amp; Performance</h2>
              <Link href="/student/classes" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">View all <ArrowRight size={12} /></Link>
            </div>
            {avgQuizScore !== null && (
              <div className="mb-4 flex items-center gap-3 rounded-xl bg-violet-50 px-4 py-3">
                <BarChart2 size={18} className="text-violet-600" />
                <div>
                  <p className="text-sm font-bold text-violet-700">{avgQuizScore}% Average Score</p>
                  <p className="text-xs text-muted">Across {quizScores.length} attempted quiz{quizScores.length !== 1 ? "zes" : ""}</p>
                </div>
              </div>
            )}
            {recentQuizzes.length === 0 ? (
              <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No quizzes available yet.</p>
            ) : (
              <div className="space-y-2.5">
                {recentQuizzes.map((q) => {
                  const sub = q.submissions[0] ?? null;
                  const pct = sub && sub.totalQuestions > 0 ? Math.round((sub.score / sub.totalQuestions) * 100) : null;
                  const isPast = q.dueDate ? now > q.dueDate : false;
                  return (
                    <article key={q.id} className="flex items-center justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{q.title}</p>
                        <p className="text-xs text-muted">{q.lecture.class.name}</p>
                        {q.dueDate && <p className="text-[11px] text-muted">Due {q.dueDate.toLocaleDateString()}</p>}
                      </div>
                      <div className="flex-shrink-0 text-right">
                        {sub ? (
                          <>
                            <p className={`text-sm font-bold ${pct !== null && pct >= 70 ? "text-emerald-600" : "text-amber-600"}`}>{pct !== null ? `${pct}%` : "N/A"}</p>
                            <p className="text-[11px] text-muted">Attempt {sub.attemptCount}</p>
                          </>
                        ) : (
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${isPast ? "bg-zinc-100 text-zinc-500" : "bg-amber-50 text-amber-700"}`}>{isPast ? "Missed" : "Pending"}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* 6. Study Materials / Notes */}
        <section className="rounded-3xl border border-border bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-bold text-foreground">Study Materials &amp; Notes</h2>
            <Link href="/student/lectures" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">View all <ArrowRight size={12} /></Link>
          </div>
          {recentNotes.length === 0 ? (
            <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No materials available yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {recentNotes.map((note) => (
                <a key={note.id} href={note.fileUrl} target="_blank" rel="noopener noreferrer" className="group flex flex-col gap-2 rounded-2xl border border-brand-100 bg-brand-50/40 p-4 transition hover:border-brand-300 hover:bg-brand-50">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="flex-shrink-0 text-brand-500" />
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${note.kind === "NOTE" ? "bg-brand-100 text-brand-700" : "bg-violet-100 text-violet-700"}`}>{note.kind === "NOTE" ? "Note" : "Material"}</span>
                  </div>
                  <p className="line-clamp-2 text-sm font-semibold text-foreground group-hover:text-brand-700">{note.title}</p>
                  <p className="text-[11px] text-muted">{note.lecture.class.name} &middot; {note.lecture.title}</p>
                  <p className="text-[11px] text-muted">{note.downloadCount} downloads</p>
                </a>
              ))}
            </div>
          )}
        </section>

        {/* 7. Monthly Materials (Bundles) */}
        <section className="rounded-3xl border border-border bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-foreground">Monthly Materials</h2>
              <p className="text-xs text-muted">Papers, tutes, and monthly packs from your teacher</p>
            </div>
            <Link href="/student/lectures" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">View all <ArrowRight size={12} /></Link>
          </div>
          {materialBundles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No material bundles sent yet.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {materialBundles.map((bundle) => (
                <article key={bundle.id} className="rounded-2xl border border-brand-100 bg-brand-50/40 p-4">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-foreground">{bundle.title}</p>
                      <p className="text-xs text-muted">{bundle.class.name} &middot; {bundle.year}/{String(bundle.month).padStart(2, "0")}</p>
                    </div>
                    <Package size={16} className="flex-shrink-0 text-brand-400" />
                  </div>
                  <div className="space-y-1.5">
                    {bundle.items.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${item.type === "PAPER" ? "bg-red-100 text-red-700" : "bg-sky-100 text-sky-700"}`}>{item.type}</span>
                          <span className="line-clamp-1 text-xs text-foreground">{item.title}</span>
                        </div>
                        {item.fileUrl && (
                          <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 text-[11px] font-medium text-brand-600 hover:underline">Download</a>
                        )}
                      </div>
                    ))}
                  </div>
                  {bundle.sentAt && <p className="mt-2 text-[11px] text-muted">Sent {bundle.sentAt.toLocaleDateString()}</p>}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* 8. Messages + Paper Support */}
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-3xl border border-border bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-bold text-foreground">Announcements</h2>
              <Link href="/student/messages" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">View all <ArrowRight size={12} /></Link>
            </div>
            {recentMessages.length === 0 ? (
              <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No messages yet.</p>
            ) : (
              <div className="space-y-2.5">
                {recentMessages.map((delivery) => (
                  <article key={delivery.id} className="rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm font-medium text-foreground">{delivery.message.content}</p>
                      <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${delivery.status === "SENT" ? "bg-emerald-100 text-emerald-700" : delivery.status === "FAILED" ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-500"}`}>{delivery.status}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted">{delivery.message.class.name} &middot; {delivery.createdAt.toLocaleDateString()}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-border bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-foreground">Paper Support Chat</h2>
                <p className="text-xs text-muted">Your recent questions to the teacher</p>
              </div>
              <Bell size={16} className="text-brand-400" />
            </div>
            {paperSupportMessages.length === 0 ? (
              <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No paper support messages yet.</p>
            ) : (
              <div className="space-y-2.5">
                {paperSupportMessages.map((msg) => (
                  <article key={msg.id} className="rounded-xl border border-violet-100 bg-violet-50/40 px-4 py-3">
                    <p className="line-clamp-2 text-sm text-foreground">{msg.message}</p>
                    <p className="mt-1 text-[11px] text-muted">{msg.class.name} &middot; {msg.item.title} &middot; {msg.createdAt.toLocaleDateString()}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 9. Payment Status */}
        <section className="rounded-3xl border border-border bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-foreground">Payment Status</h2>
              <p className="text-xs text-muted">Month: {currentMonthKey}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">{confirmedCount} Confirmed</span>
              {pendingPayCount > 0 && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">{pendingPayCount} Pending</span>}
              {unpaidCount > 0 && <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700">{unpaidCount} Unpaid</span>}
            </div>
          </div>
          {paymentDueItems.length === 0 ? (
            <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">No active class payment requirements.</p>
          ) : (
            <div className="space-y-3">
              {paymentDueItems.map((item) => {
                const p = item.payment;
                const badgeColor = !p ? (item.isPastDue ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-500") : p.status === "CONFIRMED" ? "bg-emerald-100 text-emerald-700" : p.status === "NEEDS_CLARIFICATION" ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700";
                const badgeLabel = !p ? (item.isPastDue ? "Past due" : "Not submitted") : p.status === "CONFIRMED" ? "Confirmed" : p.status === "NEEDS_CLARIFICATION" ? "Needs clarification" : "Pending review";
                return (
                  <article key={item.classId} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{item.className}</p>
                      <p className="text-xs text-muted">Teacher: {item.teacherName}</p>
                      <p className="mt-1 text-xs text-muted">Due: {item.dueDate.toLocaleDateString()} &middot; Rs {item.monthlyFee.toLocaleString()}</p>
                      {p?.teacherFeedback && <p className="mt-1 text-xs italic text-orange-700">Teacher: &ldquo;{p.teacherFeedback}&rdquo;</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badgeColor}`}>{badgeLabel}</span>
                      {!p && (
                        <Link href="/student/classes" className="btn-primary inline-flex items-center gap-1 px-3 py-1.5 text-xs">
                          <DollarSign size={11} /> Pay
                        </Link>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* 10. Attendance Tracking */}
        <section className="rounded-3xl border border-border bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-foreground">Attendance Tracking</h2>
              <p className="text-xs text-muted">Your session attendance history</p>
            </div>
            <Link href="/student/attendance" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">Full history <ArrowRight size={12} /></Link>
          </div>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <div className="flex items-center gap-3">
              <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full border-4 border-emerald-200 bg-emerald-50">
                <span className="text-lg font-bold text-emerald-700">{attendancePct}%</span>
              </div>
              <div>
                <p className="text-sm font-bold text-foreground">Overall Rate</p>
                <p className="text-xs text-muted">{attendedCount} of {attendanceTotalSessions} sessions</p>
              </div>
            </div>
            {lastAttended && (
              <div className="rounded-xl bg-brand-50 px-4 py-2">
                <p className="text-xs text-muted">Last attended</p>
                <p className="text-sm font-semibold text-foreground">{lastAttended.classSession.class.name}</p>
                <p className="text-xs text-muted">{lastAttended.joinedAt.toLocaleDateString()}</p>
              </div>
            )}
          </div>
          <div className="mb-4">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
              <div className={`h-2.5 rounded-full transition-all ${attendancePct >= 75 ? "bg-emerald-500" : attendancePct >= 50 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${attendancePct}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted">
              <span>0%</span>
              <span className={attendancePct < 75 ? "font-semibold text-amber-600" : "font-semibold text-emerald-600"}>{attendancePct < 75 ? "Below 75% target" : "Good attendance"}</span>
              <span>100%</span>
            </div>
          </div>
          {attendanceRecords.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Recent Sessions</p>
              {attendanceRecords.slice(0, 5).map((rec) => (
                <div key={rec.id} className="flex items-center justify-between gap-3 rounded-lg border border-brand-100 bg-brand-50/40 px-3 py-2">
                  <p className="text-sm font-medium text-foreground">{rec.classSession.class.name}</p>
                  <p className="text-xs text-muted">{rec.joinedAt.toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 11. Quick Actions */}
        <section className="rounded-3xl border border-border bg-white shadow-card">
          <div className="border-b border-brand-100 px-5 py-4">
            <h2 className="font-bold text-foreground">Quick Actions</h2>
            <p className="text-xs text-muted">Navigate to any section of your portal</p>
          </div>
          <div className="flex flex-wrap gap-3 p-5">
            {quickPrimaryActions.map(({ label, href, Icon }) => (
              <Link key={href} href={href} className="btn-primary inline-flex items-center gap-1.5">
                <Icon size={14} /> {label}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 border-t border-brand-100 px-5 pb-5">
            <Link href="/guardian/login" className="btn-secondary">Guardian portal</Link>
            <Link href="/" className="btn-secondary">Back to home</Link>
          </div>
        </section>

      </div>
    </>
  );
}
