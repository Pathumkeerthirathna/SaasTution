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
  Play,
  UserCheck,
  AlertCircle,
  DollarSign,
  Bell,
} from "lucide-react";
import { Weekday } from "@prisma/client";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getCurrentMonthKey, getPaymentDueDate } from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

  if (absMinutes < 1) return "now";

  const units: Array<{ limit: number; divisor: number; name: string }> = [
    { limit: 60, divisor: 1, name: "minute" },
    { limit: 60 * 24, divisor: 60, name: "hour" },
    { limit: 60 * 24 * 30, divisor: 60 * 24, name: "day" },
  ];

  for (const unit of units) {
    if (absMinutes < unit.limit) {
      const amount = Math.max(1, Math.round(absMinutes / unit.divisor));
      const s = amount === 1 ? unit.name : `${unit.name}s`;
      return diffMs >= 0 ? `in ${amount} ${s}` : `${amount} ${s} ago`;
    }
  }

  const months = Math.max(1, Math.round(absMinutes / (60 * 24 * 30)));
  return diffMs >= 0 ? `in ${months} month${months === 1 ? "" : "s"}` : `${months} month${months === 1 ? "" : "s"} ago`;
}

function getEventTone(type: UpcomingEvent["type"]) {
  if (type === "LIVE_SESSION") return "bg-rose-100 text-rose-700";
  if (type === "ASSIGNMENT") return "bg-amber-100 text-amber-700";
  return "bg-blue-100 text-blue-700";
}

function getEventLabel(type: UpcomingEvent["type"]) {
  if (type === "LIVE_SESSION") return "Live";
  if (type === "ASSIGNMENT") return "Deadline";
  return "Lecture";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatElapsed(startedAt: Date, now: Date) {
  const mins = Math.floor((now.getTime() - startedAt.getTime()) / (1000 * 60));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;


// ─── page ────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  noStore();

  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!token) redirect("/login");

  const session = await verifyAuthToken(token);
  if (!session) redirect("/login");

  if (session.role === "ADMIN") redirect("/dashboard/admin");
  if (session.role !== "TEACHER") redirect("/login");

  const teacher = await prisma.teacher.findUnique({
    where: { id: session.sub },
    select: { id: true, name: true, email: true, createdAt: true },
  });
  if (!teacher) redirect("/login");

  const now = new Date();
  const currentMonthKey = getCurrentMonthKey();
  const [currentYearNum, currentMonthNum] = currentMonthKey
    .split("-")
    .map(Number);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const next14Days = new Date(now);
  next14Days.setDate(next14Days.getDate() + 14);
  const todayWeekday = WEEKDAY_NAMES[now.getDay()] as Weekday;

  const [
    classCount,
    lectureCount,
    noteCount,
    assignmentCount,
    quizCount,
    messageCount,
    activeSessionCount,
    pendingAssignmentReviews,
    classesWithStudents,
    monthPayments,
    upcomingLectures,
    upcomingAssignments,
    activeSessionsFull,
    deliveryStats,
    paperSupportMessages,
    todaySchedules,
    recentLectures,
    recentAssignments,
    recentQuizzes,
    todayAttendees,
  ] = await Promise.all([
    // classCount
    prisma.class.count({ where: { teacherId: teacher.id } }),

    // lectureCount
    prisma.lecture.count({ where: { class: { teacherId: teacher.id } } }),

    // noteCount
    prisma.note.count({ where: { lecture: { class: { teacherId: teacher.id } } } }),

    // assignmentCount
    prisma.assignment.count({ where: { lecture: { class: { teacherId: teacher.id } } } }),

    // quizCount
    prisma.quiz.count({ where: { lecture: { class: { teacherId: teacher.id } } } }),

    // messageCount
    prisma.message.count({ where: { class: { teacherId: teacher.id } } }),

    // activeSessionCount
    prisma.classSession.count({ where: { isActive: true, class: { teacherId: teacher.id } } }),

    // pendingAssignmentReviews: past-due assignments with ≥1 submission
    prisma.assignment.count({
      where: {
        lecture: { class: { teacherId: teacher.id } },
        dueDate: { lt: now },
        submissions: { some: {} },
      },
    }),

    // classesWithStudents
    prisma.class.findMany({
      where: { teacherId: teacher.id },
      select: {
        id: true,
        name: true,
        monthlyFee: true,
        paymentDueWeek: true,
        students: {
          where: { isActive: true },
          select: {
            studentId: true,
            student: { select: { name: true, registrationNumber: true } },
          },
        },
      },
    }),

    // monthPayments
    prisma.classPayment.findMany({
      where: {
        class: { teacherId: teacher.id },
        classStudentFee: { year: currentYearNum, month: currentMonthNum },
      },
      select: { classId: true, studentId: true, amount: true, status: true },
    }),

    // upcomingLectures (next 14 days)
    prisma.lecture.findMany({
      where: { class: { teacherId: teacher.id }, date: { gte: now, lte: next14Days } },
      orderBy: { date: "asc" },
      take: 6,
      select: { id: true, title: true, date: true, class: { select: { name: true } } },
    }),

    // upcomingAssignments (next 14 days)
    prisma.assignment.findMany({
      where: { dueDate: { gte: now, lte: next14Days }, lecture: { class: { teacherId: teacher.id } } },
      orderBy: { dueDate: "asc" },
      take: 6,
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: { select: { title: true, class: { select: { name: true } } } },
      },
    }),

    // activeSessionsFull with live attendance count
    prisma.classSession.findMany({
      where: { isActive: true, class: { teacherId: teacher.id } },
      orderBy: { startedAt: "desc" },
      take: 6,
      select: {
        id: true,
        startedAt: true,
        roomName: true,
        jitsiDomain: true,
        class: { select: { id: true, name: true } },
        lecture: { select: { title: true } },
        _count: { select: { attendance: true } },
      },
    }),

    // deliveryStats
    prisma.messageDelivery.groupBy({
      by: ["status"],
      where: { message: { class: { teacherId: teacher.id } } },
      _count: { status: true },
    }),

    // paperSupportMessages
    prisma.paperSupportMessage.findMany({
      where: { teacherId: teacher.id },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        message: true,
        createdAt: true,
        class: { select: { name: true } },
        student: { select: { name: true, registrationNumber: true } },
        item: { select: { title: true } },
      },
    }),

    // todaySchedules
    prisma.classSchedule.findMany({
      where: { class: { teacherId: teacher.id }, dayOfWeek: todayWeekday },
      orderBy: { startTime: "asc" },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        class: { select: { id: true, name: true } },
      },
    }),

    // recentLectures (last 6 past lectures)
    prisma.lecture.findMany({
      where: { class: { teacherId: teacher.id }, date: { lte: now } },
      orderBy: { date: "desc" },
      take: 6,
      select: {
        id: true,
        title: true,
        date: true,
        class: { select: { name: true } },
        _count: { select: { notes: true, assignments: true, quizzes: true } },
      },
    }),

    // recentAssignments with submission count
    prisma.assignment.findMany({
      where: { lecture: { class: { teacherId: teacher.id } } },
      orderBy: { dueDate: "desc" },
      take: 6,
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: { select: { title: true, class: { select: { name: true } } } },
        _count: { select: { submissions: true } },
      },
    }),

    // recentQuizzes with submission stats
    prisma.quiz.findMany({
      where: { lecture: { class: { teacherId: teacher.id } } },
      orderBy: { dueDate: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: { select: { class: { select: { name: true } } } },
        submissions: { select: { score: true, totalQuestions: true } },
      },
    }),

    // unique students who attended a session today
    prisma.attendance.findMany({
      where: {
        classSession: {
          startedAt: { gte: todayStart, lt: todayEnd },
          class: { teacherId: teacher.id },
        },
      },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
  ]);

  // ─── derived values ───────────────────────────────────────────────────────

  const uniqueStudentIds = new Set(
    classesWithStudents.flatMap((cls) => cls.students.map((e) => e.studentId))
  );
  const activeStudentCount = uniqueStudentIds.size;

  const paymentsByKey = new Set(monthPayments.map((p) => `${p.classId}:${p.studentId}`));
  const confirmedRevenueLkr = monthPayments
    .filter((p) => p.status === "CONFIRMED")
    .reduce((s, p) => s + p.amount, 0);
  const pendingRevenueLkr = monthPayments
    .filter((p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION")
    .reduce((s, p) => s + p.amount, 0);
  const expectedRevenueLkr = classesWithStudents.reduce(
    (s, cls) => s + cls.monthlyFee * cls.students.length,
    0
  );
  const dueRevenueLkr = Math.max(expectedRevenueLkr - confirmedRevenueLkr - pendingRevenueLkr, 0);

  const confirmedPaymentCount = monthPayments.filter((p) => p.status === "CONFIRMED").length;
  const pendingPaymentCount = monthPayments.filter((p) => p.status === "PENDING").length;
  const clarificationPaymentCount = monthPayments.filter((p) => p.status === "NEEDS_CLARIFICATION").length;

  const dueStudentsFlat = classesWithStudents
    .flatMap((cls) => {
      const dueDate = getPaymentDueDate(currentMonthKey, cls.paymentDueWeek as 1 | 2 | 3 | 4);
      return cls.students
        .filter((e) => !paymentsByKey.has(`${cls.id}:${e.studentId}`))
        .map((e) => ({
          studentId: e.studentId,
          studentName: e.student.name,
          registrationNumber: e.student.registrationNumber,
          classId: cls.id,
          className: cls.name,
          dueWeek: cls.paymentDueWeek,
          dueDate,
        }));
    })
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const pendingPaymentsTotal = dueStudentsFlat.length;

  const deliveryCountByStatus = { QUEUED: 0, SENT: 0, FAILED: 0 };
  for (const row of deliveryStats) {
    deliveryCountByStatus[row.status] = row._count.status;
  }

  const upcomingEvents: UpcomingEvent[] = [
    ...upcomingLectures.map((l) => ({
      id: l.id,
      type: "LECTURE" as const,
      title: l.title,
      when: l.date,
      secondary: l.class.name,
      href: "/dashboard/lectures",
    })),
    ...upcomingAssignments.map((a) => ({
      id: a.id,
      type: "ASSIGNMENT" as const,
      title: a.title,
      when: a.dueDate,
      secondary: `${a.lecture.class.name} • ${a.lecture.title}`,
      href: "/dashboard/lectures",
    })),
    ...activeSessionsFull.map((s) => ({
      id: s.id,
      type: "LIVE_SESSION" as const,
      title: s.lecture?.title ?? "Live class in progress",
      when: s.startedAt,
      secondary: s.class.name,
      href: "/dashboard/sessions",
    })),
  ]
    .sort((a, b) => a.when.getTime() - b.when.getTime())
    .slice(0, 10);

  const attendanceTodayCount = todayAttendees.length;
  const attendanceTodayPct =
    activeStudentCount > 0
      ? Math.round((attendanceTodayCount / activeStudentCount) * 100)
      : 0;

  const quizStatsData = recentQuizzes.map((quiz) => {
    const count = quiz.submissions.length;
    const avgPct =
      count > 0
        ? Math.round(
            (quiz.submissions.reduce(
              (s, sub) => s + (sub.totalQuestions > 0 ? sub.score / sub.totalQuestions : 0),
              0
            ) /
              count) *
              100
          )
        : null;
    return {
      id: quiz.id,
      title: quiz.title,
      className: quiz.lecture.class.name,
      submissionCount: count,
      avgPct,
    };
  });

  const activeClassIds = new Set(activeSessionsFull.map((s) => s.class.id));
  const todayLabel = `${WEEKDAY_LABELS[now.getDay()]}, ${now.toLocaleDateString([], { month: "long", day: "numeric" })}`;

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full flex-col gap-6 pb-6">

      {/* ── 1. Hero + Top Summary ──────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 p-6 text-white shadow-panel sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-8 right-24 h-28 w-28 rounded-full bg-white/5" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-200">Teacher Dashboard</p>
            <h1 className="mt-2 text-2xl font-bold sm:text-3xl">
              Welcome back, {teacher.name.split(" ")[0]}
            </h1>
            <p className="mt-1.5 text-sm text-brand-200">
              {todayLabel} · Full control of your teaching workspace.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
            {[
              { label: "Classes",   value: classCount,              icon: BookOpen     },
              { label: "Students",  value: activeStudentCount,       icon: Users        },
              { label: "Live Now",  value: activeSessionCount,       icon: Radio        },
              { label: "Today",     value: todaySchedules.length,    icon: CalendarDays },
              { label: "Reviews",   value: pendingAssignmentReviews, icon: ClipboardList},
              { label: "Unpaid",    value: pendingPaymentsTotal,     icon: DollarSign   },
            ].map(({ label, value, icon: Icon }) => (
              <div
                key={label}
                className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2.5 text-white backdrop-blur-sm transition hover:bg-white/15"
              >
                <div className="flex items-center gap-1">
                  <Icon size={11} className="opacity-70" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</p>
                </div>
                <p className="mt-1 text-xl font-bold">{formatNumber(value)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 2. LIVE CLASS NOW (high-priority, only when active) ───────────── */}
      {activeSessionsFull.length > 0 && (
        <section className="overflow-hidden rounded-2xl border-2 border-rose-400 bg-rose-50 shadow-panel">
          <div className="flex items-center justify-between border-b border-rose-200 bg-rose-100 px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-600" />
              </span>
              <h2 className="font-bold text-rose-900">
                {activeSessionsFull.length} Live Class{activeSessionsFull.length > 1 ? "es" : ""} in Progress
              </h2>
            </div>
            <Link
              href="/dashboard/sessions"
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700"
            >
              <Play size={12} /> Manage sessions
            </Link>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
            {activeSessionsFull.map((liveSession) => (
              <article
                key={liveSession.id}
                className="overflow-hidden rounded-xl border border-rose-200 bg-white p-4 shadow-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-rose-900">{liveSession.class.name}</p>
                    {liveSession.lecture && (
                      <p className="mt-0.5 truncate text-xs text-muted">{liveSession.lecture.title}</p>
                    )}
                  </div>
                  <span className="flex-shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                    LIVE
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-4 text-sm text-muted">
                  <div className="flex items-center gap-1.5">
                    <Clock size={13} />
                    <span>{formatElapsed(liveSession.startedAt, now)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <UserCheck size={13} />
                    <span>{liveSession._count.attendance} joined</span>
                  </div>
                </div>
                <Link
                  href="/dashboard/sessions"
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-rose-600 py-2 text-xs font-semibold text-white transition hover:bg-rose-700"
                >
                  <Play size={12} /> Join / Manage
                </Link>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* ── 3. Today's Schedule | Attendance Today ───────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">

        {/* Today's Schedule */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-sky-50 to-white px-5 py-4">
            <div>
              <h2 className="font-bold text-foreground">Today&apos;s Schedule</h2>
              <p className="mt-0.5 text-xs text-muted">{todayLabel}</p>
            </div>
            <CalendarDays size={18} className="text-sky-500" />
          </div>
          <div className="p-5">
            {todaySchedules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-sky-200 bg-sky-50 px-4 py-4 text-sm text-muted">
                No classes scheduled for today.
              </p>
            ) : (
              <div className="space-y-2.5">
                {todaySchedules.map((sched) => {
                  const isLive = activeClassIds.has(sched.class.id);
                  return (
                    <div
                      key={sched.id}
                      className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                        isLive ? "border-rose-200 bg-rose-50" : "border-brand-100 bg-brand-50/50"
                      }`}
                    >
                      <div>
                        <p className="text-sm font-semibold text-foreground">{sched.class.name}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {sched.startTime} – {sched.endTime}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                          isLive ? "bg-rose-100 text-rose-700" : "bg-sky-100 text-sky-700"
                        }`}
                      >
                        {isLive ? "LIVE" : "Upcoming"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </article>

        {/* Attendance Today */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-4">
            <div>
              <h2 className="font-bold text-foreground">Attendance Today</h2>
              <p className="mt-0.5 text-xs text-muted">Based on today&apos;s live sessions</p>
            </div>
            <UserCheck size={18} className="text-emerald-500" />
          </div>
          <div className="space-y-4 p-5">
            <div className="flex items-end gap-4">
              <p className="text-5xl font-bold text-emerald-700">{attendanceTodayPct}%</p>
              <div className="mb-1 text-sm text-muted">
                <p>{attendanceTodayCount} unique student{attendanceTodayCount !== 1 ? "s" : ""} attended</p>
                <p>out of {activeStudentCount} enrolled</p>
              </div>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-3 rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${attendanceTodayPct}%` }}
              />
            </div>
            <div className="grid grid-cols-3 gap-2.5 pt-1">
              {[
                { label: "Attended", value: attendanceTodayCount, cls: "border-emerald-200 bg-emerald-50", valCls: "text-emerald-700", labelCls: "text-emerald-600" },
                { label: "Enrolled", value: activeStudentCount,   cls: "border-sky-200 bg-sky-50",         valCls: "text-sky-700",     labelCls: "text-sky-600"     },
                { label: "Live Now", value: activeSessionCount,   cls: "border-brand-200 bg-brand-50",     valCls: "text-brand-700",   labelCls: "text-brand-600"   },
              ].map(({ label, value, cls, valCls, labelCls }) => (
                <div key={label} className={`rounded-xl border ${cls} px-3 py-2.5 text-center`}>
                  <p className={`text-xl font-bold ${valCls}`}>{formatNumber(value)}</p>
                  <p className={`mt-0.5 text-[11px] font-semibold uppercase tracking-wide ${labelCls}`}>{label}</p>
                </div>
              ))}
            </div>
          </div>
        </article>
      </section>

      {/* ── 4. Stat cards ─────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: "Lectures",    value: lectureCount,            icon: GraduationCap, bg: "bg-violet-50",  iconCls: "bg-violet-100 text-violet-600",  valCls: "text-violet-700",  border: "border-violet-200" },
          { label: "Notes",       value: noteCount,               icon: FileText,      bg: "bg-sky-50",     iconCls: "bg-sky-100 text-sky-600",        valCls: "text-sky-700",     border: "border-sky-200"    },
          { label: "Assignments", value: assignmentCount,         icon: ClipboardList, bg: "bg-amber-50",   iconCls: "bg-amber-100 text-amber-600",    valCls: "text-amber-700",   border: "border-amber-200"  },
          { label: "Quizzes",     value: quizCount,               icon: HelpCircle,    bg: "bg-emerald-50", iconCls: "bg-emerald-100 text-emerald-600", valCls: "text-emerald-700", border: "border-emerald-200"},
          { label: "Messages",    value: messageCount,            icon: MessageSquare, bg: "bg-rose-50",    iconCls: "bg-rose-100 text-rose-600",      valCls: "text-rose-700",    border: "border-rose-200"   },
          { label: "To Review",   value: pendingAssignmentReviews,icon: Bell,          bg: "bg-orange-50",  iconCls: "bg-orange-100 text-orange-600",  valCls: "text-orange-700",  border: "border-orange-200" },
        ].map(({ label, value, icon: Icon, bg, iconCls, valCls, border }) => (
          <article
            key={label}
            className={`relative overflow-hidden rounded-2xl border ${border} ${bg} p-5 shadow-card transition hover:-translate-y-[1px] hover:shadow-md`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted">{label}</p>
                <p className={`mt-2 text-3xl font-bold ${valCls}`}>{formatNumber(value)}</p>
              </div>
              <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${iconCls}`}>
                <Icon size={18} />
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* ── 5. Monthly Revenue ────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          {
            label: "Confirmed Revenue", value: confirmedRevenueLkr,
            tone: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200",
            count: confirmedPaymentCount, countLabel: "payments confirmed",
          },
          {
            label: "Pending Revenue", value: pendingRevenueLkr,
            tone: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200",
            count: pendingPaymentCount + clarificationPaymentCount, countLabel: "awaiting review",
          },
          {
            label: "Due Revenue", value: dueRevenueLkr,
            tone: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200",
            count: pendingPaymentsTotal, countLabel: "students yet to pay",
          },
        ].map((item) => (
          <article key={item.label} className={`rounded-2xl border ${item.border} ${item.bg} p-5 shadow-card`}>
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted">
              {item.label} · {currentMonthKey}
            </p>
            <p className={`mt-2 text-3xl font-bold ${item.tone}`}>LKR {formatNumber(item.value)}</p>
            <p className="mt-1.5 text-xs text-muted">{item.count} {item.countLabel}</p>
          </article>
        ))}
      </section>

      {/* ── 6. Assignments to Review | Quiz Performance ───────────────────── */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">

        {/* Assignments */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
            <div>
              <h2 className="font-bold text-foreground">Assignments</h2>
              <p className="mt-0.5 text-xs text-muted">
                {pendingAssignmentReviews} past-due with submissions to review
              </p>
            </div>
            <Link href="/dashboard/lectures" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="p-5">
            {recentAssignments.length === 0 ? (
              <p className="rounded-xl border border-dashed border-amber-200 bg-amber-50 px-4 py-4 text-sm text-muted">
                No assignments yet.
              </p>
            ) : (
              <div className="space-y-2.5">
                {recentAssignments.map((a) => {
                  const isPast = a.dueDate < now;
                  const subCount = a._count.submissions;
                  return (
                    <div
                      key={a.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{a.title}</p>
                        <p className="mt-0.5 text-xs text-muted">{a.lecture.class.name}</p>
                        <p className="mt-0.5 text-xs text-muted">Due: {a.dueDate.toLocaleDateString()}</p>
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1">
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${subCount > 0 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                          {subCount} sub{subCount !== 1 ? "s" : ""}
                        </span>
                        {isPast && subCount > 0 && (
                          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700">Review</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </article>

        {/* Quiz Performance */}
        <article className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-violet-50 to-white px-5 py-4">
            <div>
              <h2 className="font-bold text-foreground">Quiz Performance</h2>
              <p className="mt-0.5 text-xs text-muted">Recent quizzes with average student scores</p>
            </div>
            <Link href="/dashboard/lectures" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="p-5">
            {quizStatsData.length === 0 ? (
              <p className="rounded-xl border border-dashed border-violet-200 bg-violet-50 px-4 py-4 text-sm text-muted">
                No quizzes yet.
              </p>
            ) : (
              <div className="space-y-2.5">
                {quizStatsData.map((quiz) => (
                  <div key={quiz.id} className="rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{quiz.title}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {quiz.className} · {quiz.submissionCount} attempt{quiz.submissionCount !== 1 ? "s" : ""}
                        </p>
                      </div>
                      <span className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                        quiz.avgPct === null ? "bg-gray-100 text-gray-500"
                        : quiz.avgPct >= 70 ? "bg-emerald-100 text-emerald-700"
                        : quiz.avgPct >= 40 ? "bg-amber-100 text-amber-700"
                        : "bg-rose-100 text-rose-700"
                      }`}>
                        {quiz.avgPct !== null ? `${quiz.avgPct}% avg` : "No attempts"}
                      </span>
                    </div>
                    {quiz.avgPct !== null && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-1.5 rounded-full ${quiz.avgPct >= 70 ? "bg-emerald-500" : quiz.avgPct >= 40 ? "bg-amber-500" : "bg-rose-500"}`}
                          style={{ width: `${quiz.avgPct}%` }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </article>
      </section>

      {/* ── 7. Recent Lectures & Materials ────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
          <div>
            <h2 className="font-bold text-foreground">Recent Lectures &amp; Materials</h2>
            <p className="mt-0.5 text-xs text-muted">Latest past lectures with attached notes, assignments &amp; quizzes</p>
          </div>
          <Link href="/dashboard/lectures" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
            All lectures <ArrowRight size={12} />
          </Link>
        </div>
        <div className="p-5">
          {recentLectures.length === 0 ? (
            <p className="rounded-xl border border-dashed border-brand-200 bg-brand-50 px-4 py-4 text-sm text-muted">
              No past lectures yet.
            </p>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {recentLectures.map((lecture) => (
                <article key={lecture.id} className="rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3">
                  <p className="truncate text-sm font-semibold text-foreground">{lecture.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {lecture.class.name} · {lecture.date.toLocaleDateString()}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {lecture._count.notes > 0 && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
                        {lecture._count.notes} note{lecture._count.notes !== 1 ? "s" : ""}
                      </span>
                    )}
                    {lecture._count.assignments > 0 && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        {lecture._count.assignments} assignment{lecture._count.assignments !== 1 ? "s" : ""}
                      </span>
                    )}
                    {lecture._count.quizzes > 0 && (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                        {lecture._count.quizzes} quiz{lecture._count.quizzes !== 1 ? "zes" : ""}
                      </span>
                    )}
                    {lecture._count.notes === 0 && lecture._count.assignments === 0 && lecture._count.quizzes === 0 && (
                      <span className="text-[11px] text-muted">No resources attached</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 8. Upcoming Events | Communication Insights ───────────────────── */}
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
                      <p className="mt-1 text-xs text-muted">
                        {formatCompactDateTime(event.when)} · {buildRelativeLabel(event.when)}
                      </p>
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
          <div className="space-y-3 p-5">
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
          </div>
        </article>
      </section>

      {/* ── 9. Payment Tracking ───────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-rose-50 to-white px-5 py-4">
          <div>
            <h2 className="font-bold text-foreground">Payment Tracking · {currentMonthKey}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {pendingPaymentsTotal} student{pendingPaymentsTotal !== 1 ? "s" : ""} yet to submit payment this month
            </p>
          </div>
          <Link href="/dashboard/classes" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
            Open class payments <ArrowRight size={12} />
          </Link>
        </div>
        {/* Status summary */}
        <div className="grid grid-cols-3 gap-3 border-b border-brand-100 p-5">
          {[
            { label: "Confirmed",     value: confirmedPaymentCount,    icon: CheckCircle2, cls: "border-emerald-200 bg-emerald-50", valCls: "text-emerald-700", iconCls: "text-emerald-600" },
            { label: "Pending",       value: pendingPaymentCount,      icon: Clock,        cls: "border-amber-200 bg-amber-50",    valCls: "text-amber-700",   iconCls: "text-amber-600"   },
            { label: "Clarification", value: clarificationPaymentCount,icon: AlertCircle,  cls: "border-rose-200 bg-rose-50",      valCls: "text-rose-700",    iconCls: "text-rose-600"    },
          ].map(({ label, value, icon: Icon, cls, valCls, iconCls }) => (
            <div key={label} className={`rounded-xl border ${cls} px-4 py-3 text-center`}>
              <Icon size={16} className={`mx-auto ${iconCls}`} />
              <p className={`mt-1.5 text-2xl font-bold ${valCls}`}>{value}</p>
              <p className={`mt-0.5 text-[11px] font-semibold uppercase tracking-wide ${iconCls}`}>{label}</p>
            </div>
          ))}
        </div>
        {/* Due students list */}
        <div className="p-5">
          {dueStudentsFlat.length === 0 ? (
            <p className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-muted">
              All students have submitted payment for this month.
            </p>
          ) : (
            <div className="space-y-2">
              {dueStudentsFlat.slice(0, 10).map((item) => (
                <article
                  key={`${item.classId}-${item.studentId}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {item.studentName}
                      {item.registrationNumber && (
                        <span className="ml-1 text-xs font-normal text-muted">
                          ({item.registrationNumber})
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {item.className} · Week {item.dueWeek}
                    </p>
                  </div>
                  <p className="text-xs font-semibold text-rose-700">
                    Due: {item.dueDate.toLocaleDateString()}
                  </p>
                </article>
              ))}
              {dueStudentsFlat.length > 10 && (
                <p className="pt-1 text-center text-xs text-muted">
                  +{dueStudentsFlat.length - 10} more →{" "}
                  <Link href="/dashboard/classes" className="font-semibold text-brand-700 hover:underline">
                    view all
                  </Link>
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── 10. Announcements & Paper Late Messages ────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
          <div>
            <h2 className="font-bold text-foreground">Paper late reasons from students</h2>
            <p className="mt-0.5 text-xs text-muted">
              Messages sent when students miss paper submission deadlines
            </p>
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
                      {msg.student.registrationNumber && (
                        <span className="ml-1.5 text-xs font-normal text-muted">
                          ({msg.student.registrationNumber})
                        </span>
                      )}
                    </p>
                    <time className="text-xs text-muted">{new Date(msg.createdAt).toLocaleString()}</time>
                  </div>
                  <p className="mt-1 text-xs font-medium text-brand-600">
                    {msg.class.name} · {msg.item.title}
                  </p>
                  <p className="mt-2 whitespace-pre-line text-sm text-foreground">{msg.message}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 11. Quick Actions ─────────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-5 py-4">
          <h2 className="font-bold text-foreground">Quick Actions</h2>
          <p className="mt-0.5 text-xs text-muted">Jump to any section instantly</p>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {[
              { href: "/dashboard/classes",  label: "Manage Classes",  icon: BookOpen      },
              { href: "/dashboard/sessions", label: "Live Sessions",   icon: Radio         },
              { href: "/dashboard/lectures", label: "Lectures",        icon: GraduationCap },
              { href: "/dashboard/students", label: "Students",        icon: Users         },
              { href: "/dashboard/messages", label: "Announcements",   icon: MessageSquare },
              { href: "/dashboard/classes",  label: "Payments",        icon: DollarSign    },
            ].map(({ href, label, icon: Icon }) => (
              <Link
                key={label}
                href={href}
                className="btn-primary flex items-center justify-center gap-2 py-3"
              >
                <Icon size={14} />
                <span className="text-xs">{label}</span>
              </Link>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 border-t border-brand-100 pt-3">
            <Link href="/guardian/login"   className="btn-secondary">Guardian portal</Link>
            <Link href="/account/security" className="btn-secondary">Account security</Link>
            <Link href="/"                 className="btn-secondary">Back to home</Link>
          </div>
        </div>
      </section>

    </div>
  );
}
