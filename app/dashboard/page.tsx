import { cookies } from "next/headers";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  Users,
  Radio,
  CalendarDays,
  ClipboardList,
  CheckCircle2,
  Clock,
  ArrowRight,
  Play,
  UserCheck,
  AlertCircle,
  DollarSign,
} from "lucide-react";
import { Weekday } from "@prisma/client";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getCurrentMonthKey, getPaymentDueDate } from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";
import { getActiveYouTubeLives } from "@/lib/youtube-live-status";
import { DashboardCountdown } from "@/components/dashboard/dashboard-countdown";
import { LiveBroadcastCard } from "@/components/dashboard/live-broadcast-card";
import { DashboardMetricCards } from "@/components/dashboard/dashboard-metric-cards";
import { DashboardScheduleEvents } from "@/components/dashboard/dashboard-schedule-events";
import { DashboardCoursework } from "@/components/dashboard/dashboard-coursework";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  const todayWeekday = WEEKDAY_NAMES[now.getDay()] as Weekday;

  const [
    classCount,
    activeSessionCount,
    pendingAssignmentReviews,
    classesWithStudents,
    monthPayments,
    activeSessionsFull,
    paperSupportMessages,
    todaySchedules,
    studentsTotalCount,
    studentsPendingCount,
  ] = await Promise.all([
    // classCount
    prisma.class.count({ where: { teacherId: teacher.id, status: 0 } }),

    // activeSessionCount
    prisma.classSession.count({
      where: {
        isActive: true,
        class: { teacherId: teacher.id, status: 0 },
        OR: [{ lectureId: null }, { lecture: { status: 0 } }],
      },
    }),

    // pendingAssignmentReviews: past-due assignments with ≥1 submission
    prisma.assignment.count({
      where: {
        status: 0,
        lecture: { status: 0, class: { teacherId: teacher.id, status: 0 } },
        dueDate: { lt: now },
        submissions: { some: {} },
      },
    }),

    // classesWithStudents
    prisma.class.findMany({
      where: { teacherId: teacher.id, status: 0 },
      select: {
        id: true,
        name: true,
        monthlyFee: true,
        paymentDueWeek: true,
        students: {
          where: { isActive: true, student: { status: 0 } },
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
        class: { teacherId: teacher.id, status: 0 },
        classStudentFee: { year: currentYearNum, month: currentMonthNum },
      },
      select: { classId: true, studentId: true, amount: true, status: true },
    }),

    // activeSessionsFull with live attendance count
    prisma.classSession.findMany({
      where: {
        isActive: true,
        class: { teacherId: teacher.id, status: 0 },
        OR: [{ lectureId: null }, { lecture: { status: 0 } }],
      },
      orderBy: { startedAt: "desc" },
      take: 6,
      select: {
        id: true,
        startedAt: true,
        roomName: true,
        jitsiDomain: true,
        class: { select: { id: true, name: true } },
        lecture: { select: { title: true } },
        _count: { select: { attendance: { where: { student: { status: 0 } } } } },
      },
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
      where: { class: { teacherId: teacher.id, status: 0 }, dayOfWeek: todayWeekday },
      orderBy: { startTime: "asc" },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        class: { select: { id: true, name: true } },
      },
    }),

    // studentsTotalCount (active)
    prisma.student.count({ where: { teacherId: teacher.id, status: 0 } }),

    // studentsPendingCount (active, awaiting confirmation)
    prisma.student.count({
      where: {
        teacherId: teacher.id,
        status: 0,
        confirmationStatus: "PENDING",
      },
    }),
  ]);

  // ─── "starts within 8 hours" countdown ────────────────────────────────────

  const COUNTDOWN_WINDOW_MS = 8 * 60 * 60 * 1000;
  const countdownWindowEnd = new Date(now.getTime() + COUNTDOWN_WINDOW_MS);

  const [countdownLectures, teacherSchedules, calendarEvents, nearbyLectures] =
    await Promise.all([
      prisma.lecture.findMany({
        where: {
          status: 0,
          class: { teacherId: teacher.id, status: 0 },
          date: { gt: now, lte: countdownWindowEnd },
        },
        orderBy: { date: "asc" },
        select: {
          id: true,
          title: true,
          date: true,
          classId: true,
          class: { select: { name: true } },
        },
      }),
      prisma.classSchedule.findMany({
        where: { class: { teacherId: teacher.id, status: 0 } },
        select: {
          id: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          classId: true,
          class: { select: { name: true } },
        },
      }),
      prisma.teacherCalendarEvent.findMany({
        where: {
          teacherId: teacher.id,
          status: 0,
          startDateTime: { gt: now, lte: countdownWindowEnd },
        },
        orderBy: { startDateTime: "asc" },
        select: {
          id: true,
          title: true,
          startDateTime: true,
          eventType: { select: { name: true } },
        },
      }),
      // Lectures on today / tomorrow — used to tell if a schedule occurrence
      // already has a lecture attached.
      prisma.lecture.findMany({
        where: {
          status: 0,
          class: { teacherId: teacher.id, status: 0 },
          date: {
            gte: todayStart,
            lte: new Date(now.getTime() + COUNTDOWN_WINDOW_MS + 24 * 60 * 60 * 1000),
          },
        },
        select: { classId: true, date: true },
      }),
    ]);

  function nextScheduleOccurrence(dayOfWeek: string, timeStr: string) {
    const targetDow = WEEKDAY_NAMES.indexOf(dayOfWeek as (typeof WEEKDAY_NAMES)[number]);
    if (targetDow < 0) return null;
    const [h, m] = timeStr.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

    const occ = new Date(now);
    occ.setHours(0, 0, 0, 0);
    occ.setDate(occ.getDate() + ((targetDow - occ.getDay() + 7) % 7));
    occ.setHours(h, m, 0, 0);
    if (occ.getTime() <= now.getTime()) {
      occ.setDate(occ.getDate() + 7);
    }
    return occ;
  }

  function isSameDay(a: Date, b: Date) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  const countdownItems: {
    id: string;
    kind: "LECTURE" | "SCHEDULE" | "EVENT";
    title: string;
    subtitle: string;
    startsAt: string;
    needsLecture: boolean;
    actionHref: string;
    actionLabel: string;
  }[] = [];

  for (const lecture of countdownLectures) {
    countdownItems.push({
      id: `lecture-${lecture.id}`,
      kind: "LECTURE",
      title: lecture.title,
      subtitle: lecture.class.name,
      startsAt: lecture.date.toISOString(),
      needsLecture: false,
      actionHref: "/dashboard/lectures",
      actionLabel: "Open lectures",
    });
  }

  for (const schedule of teacherSchedules) {
    const start = nextScheduleOccurrence(schedule.dayOfWeek, schedule.startTime);
    if (!start || start.getTime() > countdownWindowEnd.getTime()) continue;

    const hasLecture = nearbyLectures.some(
      (lecture) =>
        lecture.classId === schedule.classId && isSameDay(lecture.date, start)
    );

    // A lecture is already attached for this occurrence — the lecture entry
    // (or nothing) handles it; no need to nag.
    if (hasLecture) continue;

    countdownItems.push({
      id: `schedule-${schedule.id}`,
      kind: "SCHEDULE",
      title: schedule.class.name,
      subtitle: `${schedule.startTime}–${schedule.endTime}`,
      startsAt: start.toISOString(),
      needsLecture: true,
      actionHref: "/dashboard/lectures",
      actionLabel: "Add lecture",
    });
  }

  for (const event of calendarEvents) {
    countdownItems.push({
      id: `event-${event.id}`,
      kind: "EVENT",
      title: event.title,
      subtitle: event.eventType?.name ?? "Event",
      startsAt: event.startDateTime.toISOString(),
      needsLecture: false,
      actionHref: "/dashboard/calendar",
      actionLabel: "Open calendar",
    });
  }

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

  const todayLabel = `${WEEKDAY_LABELS[now.getDay()]}, ${now.toLocaleDateString([], { month: "long", day: "numeric" })}`;

  const liveBroadcasts = await getActiveYouTubeLives({ teacherId: teacher.id });

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full flex-col gap-6 pb-6">

      {/* ── 1. Hero + Top Summary ──────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-3xl bg-[#32598A] p-6 text-white shadow-panel sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-8 right-24 h-28 w-28 rounded-full bg-white/5" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-blue-300">Teacher Dashboard</p>
            <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">
              Welcome back, {teacher.name.split(" ")[0]}
            </h1>
            <p className="mt-1.5 text-sm text-white/70">
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

      <DashboardCountdown items={countdownItems} />

      <LiveBroadcastCard broadcasts={liveBroadcasts} tone="rose" />

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
                <a
                  href={`/session/join?sessionId=${liveSession.id}&role=teacher`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-rose-600 py-2 text-xs font-semibold text-white transition hover:bg-rose-700"
                >
                  <Play size={12} /> Join session
                </a>
              </article>
            ))}
          </div>
        </section>
      )}

      <DashboardMetricCards
        studentsPending={studentsPendingCount}
        studentsTotal={studentsTotalCount}
      />

      {/* ── 3. Schedule | Events (range-selectable) ──────────────────────── */}
      <DashboardScheduleEvents />

      {/* ── 3b. Assignments & Quizzes with submissions (range-selectable) ── */}
      <DashboardCoursework />

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

    </div>
  );
}
