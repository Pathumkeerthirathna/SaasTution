import { cookies } from "next/headers";
import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  Users,
  Radio,
  CalendarDays,
  Clock,
  ArrowRight,
  Play,
  UserCheck,
  DollarSign,
} from "lucide-react";
import { ClassPaymentStatus, Weekday } from "@prisma/client";
import { Eye } from "lucide-react";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getCurrentMonthKey, getPaymentDueDate, getPaymentDueStatus } from "@/lib/payment-validation";
import { formatStoredSriLankaDate, nowInSriLanka } from "@/lib/time";
import { prisma } from "@/lib/prisma";
import { getActiveYouTubeLives } from "@/lib/youtube-live-status";
import { DashboardCountdown } from "@/components/dashboard/dashboard-countdown";
import { LiveBroadcastCard } from "@/components/dashboard/live-broadcast-card";
import { DashboardMetricCards } from "@/components/dashboard/dashboard-metric-cards";
import { DashboardScheduleEvents } from "@/components/dashboard/dashboard-schedule-events";
import { DashboardCoursework } from "@/components/dashboard/dashboard-coursework";
import { DashboardPaperReviews } from "@/components/dashboard/dashboard-paper-reviews";
import { DashboardBundlePaperReviews } from "@/components/dashboard/dashboard-bundle-paper-reviews";
import { TeacherRealtimeRefresh } from "@/components/dashboard/teacher-realtime-refresh";
import { TeacherPlanSelection } from "@/components/dashboard/teacher-plan-selection";

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
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      isConfirmed: true,
      isRejected: true,
    },
  });
  if (!teacher) redirect("/login");

  // A teacher whose registration is still pending admin review sees this
  // exact same dashboard rendered with sample data instead of their own
  // (mostly-empty) real records, plus a plan picker above it. The dashboard
  // itself is unchanged — only the inputs feeding it are swapped below.
  const isPending = !teacher.isConfirmed && !teacher.isRejected;

  const now = new Date();
  const currentMonthKey = getCurrentMonthKey();
  const [currentYearNum, currentMonthNum] = currentMonthKey
    .split("-")
    .map(Number);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayWeekday = WEEKDAY_NAMES[now.getDay()] as Weekday;

  // A pending teacher has no real data of their own yet, so the exact same
  // dashboard below is fed sample values instead of live Prisma queries —
  // nothing in the rendered dashboard itself changes.
  const {
    classCount,
    activeSessionCount,
    classesWithStudents,
    monthPayments,
    activeSessionsFull,
    paperSupportMessages,
    todaySchedules,
    studentsTotalCount,
    studentsPendingCount,
  } = isPending
    ? {
        classCount: 3,
        activeSessionCount: 0,
        classesWithStudents: [
          {
            id: "demo-class-1",
            name: "Combined Maths — Grade 12",
            monthlyFee: 4500,
            paymentDueWeek: 2,
            students: [
              {
                studentId: "demo-student-1",
                student: { name: "Nimal Perera", registrationNumber: "ST20260014" },
              },
              {
                studentId: "demo-student-2",
                student: { name: "Kavindi Silva", registrationNumber: "ST20260021" },
              },
            ],
          },
          {
            id: "demo-class-2",
            name: "Physics — Grade 11",
            monthlyFee: 4000,
            paymentDueWeek: 1,
            students: [
              {
                studentId: "demo-student-3",
                student: { name: "Sachini Fernando", registrationNumber: "ST20260033" },
              },
            ],
          },
        ],
        monthPayments: [
          { classId: "demo-class-1", studentId: "demo-student-1", amount: 4500, status: ClassPaymentStatus.CONFIRMED },
          { classId: "demo-class-2", studentId: "demo-student-3", amount: 4000, status: ClassPaymentStatus.PENDING },
        ],
        activeSessionsFull: [] as {
          id: string;
          startedAt: Date;
          roomName: string;
          jitsiDomain: string;
          class: { id: string; name: string };
          lecture: { title: string } | null;
          joinedCount: number;
        }[],
        paperSupportMessages: [
          {
            id: "demo-msg-1",
            message: "I was unwell and could not submit on time.",
            createdAt: now,
            class: { name: "Combined Maths — Grade 12" },
            student: { name: "Sachini Fernando", registrationNumber: "ST20260033" },
            item: { title: "Assignment 3" },
          },
        ],
        todaySchedules: [
          { id: "demo-schedule-1", startTime: "09:00", endTime: "10:30", class: { id: "demo-class-1", name: "Combined Maths — Grade 12" } },
          { id: "demo-schedule-2", startTime: "14:00", endTime: "15:30", class: { id: "demo-class-2", name: "Physics — Grade 11" } },
        ],
        studentsTotalCount: 42,
        studentsPendingCount: 6,
      }
    : await (async () => {
        const [
          classCount,
          activeSessionCount,
          classesWithStudents,
          monthPayments,
          activeSessionsRaw,
          distinctSessionAttendance,
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

          // activeSessionsRaw
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
            },
          }),

          // distinctSessionAttendance — one row per student per session, so a
          // student who joins/leaves/rejoins the same session only counts once.
          prisma.attendance.findMany({
            where: {
              classSession: {
                isActive: true,
                class: { teacherId: teacher.id, status: 0 },
                OR: [{ lectureId: null }, { lecture: { status: 0 } }],
              },
              student: { status: 0 },
            },
            select: { classSessionId: true, studentId: true },
            distinct: ["classSessionId", "studentId"],
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

        const joinedCountBySession = new Map<string, number>();
        for (const row of distinctSessionAttendance) {
          joinedCountBySession.set(
            row.classSessionId,
            (joinedCountBySession.get(row.classSessionId) ?? 0) + 1
          );
        }

        const activeSessionsFull = activeSessionsRaw.map((session) => ({
          ...session,
          joinedCount: joinedCountBySession.get(session.id) ?? 0,
        }));

        return {
          classCount,
          activeSessionCount,
          classesWithStudents,
          monthPayments,
          activeSessionsFull,
          paperSupportMessages,
          todaySchedules,
          studentsTotalCount,
          studentsPendingCount,
        };
      })();

  // ─── "starts within 8 hours" countdown ────────────────────────────────────

  const COUNTDOWN_WINDOW_MS = 8 * 60 * 60 * 1000;
  const countdownWindowEnd = new Date(now.getTime() + COUNTDOWN_WINDOW_MS);

  type CountdownItem = {
    id: string;
    kind: "LECTURE" | "SCHEDULE" | "EVENT";
    title: string;
    subtitle: string;
    startsAt: string;
    needsLecture: boolean;
    actionHref: string;
    actionLabel: string;
  };

  const countdownItems: CountdownItem[] = isPending
    ? [
        {
          id: "demo-countdown-1",
          kind: "LECTURE",
          title: "Mechanics Revision",
          subtitle: "Combined Maths — Grade 12",
          startsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          needsLecture: false,
          actionHref: "/dashboard/lectures",
          actionLabel: "Open lectures",
        },
        {
          id: "demo-countdown-2",
          kind: "SCHEDULE",
          title: "Physics — Grade 11",
          subtitle: "14:00–15:30",
          startsAt: new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString(),
          needsLecture: true,
          actionHref: "/dashboard/lectures",
          actionLabel: "Add lecture",
        },
      ]
    : await (async () => {
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

        const items: CountdownItem[] = [];

        for (const lecture of countdownLectures) {
          items.push({
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

          items.push({
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
          items.push({
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

        return items;
      })();

  // ─── derived values ───────────────────────────────────────────────────────

  const paymentsByKey = new Set(monthPayments.map((p) => `${p.classId}:${p.studentId}`));
  const confirmedRevenueLkr = monthPayments
    .filter((p) => p.status === "CONFIRMED")
    .reduce((s, p) => s + p.amount, 0);
  const clarificationRevenueLkr = monthPayments
    .filter((p) => p.status === "NEEDS_CLARIFICATION")
    .reduce((s, p) => s + p.amount, 0);

  const confirmedPaymentCount = monthPayments.filter((p) => p.status === "CONFIRMED").length;
  const pendingPaymentCount = monthPayments.filter((p) => p.status === "PENDING").length;
  const clarificationPaymentCount = monthPayments.filter((p) => p.status === "NEEDS_CLARIFICATION").length;

  const nowSriLanka = nowInSriLanka();

  const dueStudentsFlat = classesWithStudents
    .flatMap((cls) => {
      const dueDate = getPaymentDueDate(currentMonthKey, cls.paymentDueWeek as 1 | 2 | 3 | 4);
      const dueStatus = getPaymentDueStatus(dueDate, nowSriLanka);

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
          dueStatus,
          amount: cls.monthlyFee,
        }));
    })
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const pendingPaymentsTotal = dueStudentsFlat.length;
  const overdueStudentsCount = dueStudentsFlat.filter((s) => s.dueStatus === "OVERDUE").length;
  const dueSoonStudentsCount = dueStudentsFlat.filter((s) => s.dueStatus === "DUE_SOON").length;
  const unpaidStudentsCount = dueStudentsFlat.filter((s) => s.dueStatus === "UPCOMING").length;
  const overdueRevenueLkr = dueStudentsFlat
    .filter((s) => s.dueStatus === "OVERDUE")
    .reduce((sum, s) => sum + s.amount, 0);
  const dueSoonRevenueLkr = dueStudentsFlat
    .filter((s) => s.dueStatus === "DUE_SOON")
    .reduce((sum, s) => sum + s.amount, 0);
  const totalUnpaidRevenueLkr = dueStudentsFlat.reduce((sum, s) => sum + s.amount, 0);

  const todayLabel = `${WEEKDAY_LABELS[now.getDay()]}, ${now.toLocaleDateString([], { month: "long", day: "numeric" })}`;

  const liveBroadcasts = isPending
    ? []
    : await getActiveYouTubeLives({ teacherId: teacher.id });

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full flex-col gap-6 pb-6">
      {isPending && <TeacherPlanSelection />}

      {isPending && (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-2.5 text-[12.5px] text-slate-500">
          <Eye className="h-3.5 w-3.5 shrink-0" />
          Preview only — this is what your dashboard will look like, with
          sample data. It unlocks once your account is confirmed.
        </div>
      )}

      <div
        className={
          isPending
            ? "pointer-events-none flex select-none flex-col gap-6 opacity-90"
            : "flex flex-col gap-6"
        }
      >
      {/* Keeps the server-rendered hero summary, live sections and coursework
          lists in sync; DashboardMetricCards/ScheduleEvents/Coursework below
          manage their own SSE-driven refetches for their client-fetched data. */}
      <TeacherRealtimeRefresh events={["counts-stale", "sessions", "broadcasts"]} />

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
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5">
            {[
              { label: "Classes",   value: classCount,              icon: BookOpen,     sub: null as string | null },
              { label: "Students",  value: studentsTotalCount,       icon: Users,        sub: null as string | null },
              { label: "Live Now",  value: activeSessionCount,       icon: Radio,        sub: null as string | null },
              { label: "Today",     value: todaySchedules.length,    icon: CalendarDays, sub: null as string | null },
              {
                label: "Unpaid",
                value: pendingPaymentsTotal,
                icon: DollarSign,
                sub: `LKR ${formatNumber(totalUnpaidRevenueLkr)}`,
              },
            ].map(({ label, value, icon: Icon, sub }) => (
              <div
                key={label}
                className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2.5 text-white backdrop-blur-sm transition hover:bg-white/15"
              >
                <div className="flex items-center gap-1">
                  <Icon size={11} className="opacity-70" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</p>
                </div>
                <p className="mt-1 text-xl font-bold">{formatNumber(value)}</p>
                {sub ? <p className="mt-0.5 text-[10px] font-semibold opacity-70">{sub}</p> : null}
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
                    <p className="break-words font-bold text-rose-900 sm:truncate">{liveSession.class.name}</p>
                    {liveSession.lecture && (
                      <p className="mt-0.5 break-words text-xs text-muted sm:truncate">{liveSession.lecture.title}</p>
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
                    <span>{liveSession.joinedCount} joined</span>
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

      {/* ── 3c/3d. Paper submissions awaiting a mark ───────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashboardPaperReviews />
        <DashboardBundlePaperReviews />
      </section>

      {/* ── 5. Monthly Revenue ────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-card">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted">
            Confirmed Revenue · {currentMonthKey}
          </p>
          <p className="mt-2 text-3xl font-bold text-emerald-700">
            LKR {formatNumber(confirmedRevenueLkr)}
          </p>
          <p className="mt-1.5 text-xs text-muted">{confirmedPaymentCount} payments confirmed</p>
        </article>

        {/* Due Soon — unpaid students within 5 days of their due date. */}
        <article className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-card">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted">
            Due Soon · {currentMonthKey}
          </p>
          <p className="mt-2 text-3xl font-bold text-amber-700">{dueSoonStudentsCount}</p>
          <p className="mt-1.5 text-xs text-muted">
            LKR {formatNumber(dueSoonRevenueLkr)} due soon
          </p>
        </article>

        {/* Payments Due — overdue count/revenue is the headline; due-soon and
            awaiting-confirmation counts are shown as secondary context. */}
        <article className="rounded-2xl border border-rose-200 bg-rose-50 p-5 shadow-card">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted">
            Payments Due · {currentMonthKey}
          </p>
          <p className="mt-2 text-3xl font-bold text-rose-700">{overdueStudentsCount}</p>
          <p className="mt-1.5 text-xs text-muted">
            LKR {formatNumber(overdueRevenueLkr)} total due
          </p>
        </article>

        {/* Clarification — student submitted a payment, but the teacher hasn't
            confirmed it (or has asked the student for more information). */}
        <article className="rounded-2xl border border-orange-200 bg-orange-50 p-5 shadow-card">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted">
            Clarification · {currentMonthKey}
          </p>
          <p className="mt-2 text-3xl font-bold text-orange-700">{clarificationPaymentCount}</p>
          <p className="mt-1.5 text-xs text-muted">
            LKR {formatNumber(clarificationRevenueLkr)} awaiting clarification
          </p>
        </article>
      </section>

      {/* ── 9. Payment Tracking ───────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-rose-50 to-white px-5 py-4">
          <div>
            <h2 className="font-bold text-foreground">Payment Tracking · {currentMonthKey}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {pendingPaymentsTotal === 0
                ? "All students have submitted payment for this month"
                : [
                    overdueStudentsCount > 0 &&
                      `${overdueStudentsCount} overdue`,
                    dueSoonStudentsCount > 0 &&
                      `${dueSoonStudentsCount} due soon`,
                    unpaidStudentsCount > 0 &&
                      `${unpaidStudentsCount} unpaid`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
          </div>
          <Link href="/dashboard/payments" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
            Open class payments <ArrowRight size={12} />
          </Link>
        </div>
        {/* Due students list */}
        <div className="p-5">
          {dueStudentsFlat.length === 0 ? (
            <p className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-muted">
              All students have submitted payment for this month.
            </p>
          ) : (
            <div className="space-y-2">
              {dueStudentsFlat.slice(0, 10).map((item) => {
                const cardCls =
                  item.dueStatus === "OVERDUE"
                    ? "border-rose-200 bg-rose-50/60"
                    : item.dueStatus === "DUE_SOON"
                    ? "border-amber-200 bg-amber-50/60"
                    : "border-slate-200 bg-slate-50/60";
                const textCls =
                  item.dueStatus === "OVERDUE"
                    ? "text-rose-700"
                    : item.dueStatus === "DUE_SOON"
                    ? "text-amber-700"
                    : "text-slate-600";
                const label =
                  item.dueStatus === "OVERDUE"
                    ? "Due"
                    : item.dueStatus === "DUE_SOON"
                    ? "Due soon"
                    : "Unpaid";

                return (
                  <article
                    key={`${item.classId}-${item.studentId}`}
                    className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 ${cardCls}`}
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
                    <p className={`text-xs font-semibold ${textCls}`}>
                      {label}: {formatStoredSriLankaDate(item.dueDate)}
                    </p>
                  </article>
                );
              })}
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
    </div>
  );
}
