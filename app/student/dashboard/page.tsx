import { unstable_noStore as noStore } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  Clock,
  ClipboardList,
  MessageSquare,
  ArrowRight,
  Bell,
  FileText,
  UserCheck,
  BookMarked,
} from "lucide-react";
import { Weekday } from "@prisma/client";

import { requireStudentSession } from "@/lib/auth-session";
import { getCurrentMonthKey } from "@/lib/payment-validation";
import { prisma } from "@/lib/prisma";
import { getActiveYouTubeLives } from "@/lib/youtube-live-status";
import { verifySessionInviteToken } from "@/lib/session-invite";
import { PaperCountdownList } from "@/components/student-portal/paper-countdown-list";
import { DashboardCountdowns } from "@/components/student-portal/dashboard-countdowns";
import { getStudentUpcomingCountdowns } from "@/services/student-countdown-service";
import { LiveDashboardSection } from "@/components/student-portal/live-dashboard-section";
import { DashboardAgenda } from "@/components/student-portal/dashboard-agenda";
import { DashboardPaymentStatus } from "@/components/student-portal/dashboard-payment-status";
import { DashboardStudyNotes } from "@/components/student-portal/dashboard-study-notes";
import { DashboardPerformance } from "@/components/student-portal/dashboard-performance";
import { getStudentDashboardCounts } from "@/services/student-dashboard-counts-service";
import { RealtimeRefresh } from "@/components/student-portal/realtime-refresh";

// helpers

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

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
  const todayWeekday = WEEKDAY_NAMES[now.getDay()] as Weekday;

  const [
    enrolledClasses,
    liveSessions,
    todaySchedules,
    pendingAssignments,
    recentMessages,
    paperSupportMessages,
    paymentsThisMonth,
    upcomingPaperItems,
  ] = await Promise.all([

    prisma.classStudent.findMany({
      where: { studentId, isActive: true, class: { status: 0 } },
      select: { classId: true },
      orderBy: { assignedAt: "asc" },
    }),

    prisma.classSession.findMany({
      where: {
        isActive: true,
        class: { status: 0, students: { some: { studentId, isActive: true } } },
        OR: [{ lectureId: null }, { lecture: { status: 0 } }],
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        roomName: true,
        jitsiDomain: true,
        class: { select: { id: true, name: true, teacher: { select: { name: true } } } },
        lecture: { select: { title: true } },
        _count: { select: { attendance: { where: { student: { status: 0 } } } } },
      },
    }),

    prisma.classSchedule.findMany({
      where: {
        dayOfWeek: todayWeekday,
        class: { status: 0, students: { some: { studentId, isActive: true } } },
      },
      select: { id: true },
    }),

    prisma.assignment.findMany({
      where: {
        status: 0,
        lecture: { status: 0, class: { status: 0, students: { some: { studentId, isActive: true } } } },
        dueDate: { gte: now },
        submissions: { none: { studentId } },
      },
      select: { id: true },
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
        class: { status: 0 },
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

    prisma.materialBundleItem.findMany({
      where: {
        type: "PAPER",
        status: 0,
        paperStartAt: { not: null },
        bundle: {
          bundleStatus: "SENT",
          status: 0,
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

  const studentRecord = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      confirmationStatus: true,
      status: true,
      deactivationReason: true,
      teacher: {
        select: {
          name: true,
          profile: { select: { phone: true, whatsapp: true } },
        },
      },
    },
  });

  const teacherContacts = [
    studentRecord?.teacher?.profile?.phone,
    studentRecord?.teacher?.profile?.whatsapp,
  ]
    .filter(Boolean)
    .join(" / ");

  const liveBroadcasts = await getActiveYouTubeLives({ studentId });
  const upcomingCountdowns = await getStudentUpcomingCountdowns(studentId);
  const dashboardCounts = await getStudentDashboardCounts(studentId, "month");

  // derived values

  const enrolledCount = enrolledClasses.length;
  const todayLabel = `${WEEKDAY_LABELS[now.getDay()]}, ${now.toLocaleDateString([], { month: "long", day: "numeric" })}`;

  const confirmedCount = paymentsThisMonth.filter((p) => p.status === "CONFIRMED").length;
  const pendingPayCount = paymentsThisMonth.filter(
    (p) => p.status === "PENDING" || p.status === "NEEDS_CLARIFICATION"
  ).length;
  const unpaidCount = enrolledCount - confirmedCount - pendingPayCount;

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
      {/* Keeps the server-rendered hero summary + announcement lists in sync; the
          interactive widgets below manage their own SSE subscriptions. */}
      <RealtimeRefresh debounceMs={1000} />

      <div className="flex w-full flex-col gap-6 pb-6">

        {/* 1. Hero */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-emerald-700 to-teal-800 p-6 text-white shadow-panel sm:p-8">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/5" />
          <div className="pointer-events-none absolute -bottom-8 right-24 h-28 w-28 rounded-full bg-white/5" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-100/90">Student Dashboard</p>
              <h1 className="mt-2 text-2xl font-bold sm:text-3xl">
                Welcome back, {studentSession.name.split(" ")[0]}
              </h1>
              <p className="mt-1.5 text-sm text-emerald-100/90">{todayLabel} &middot; Your learning command center.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {[
                  { label: `${enrolledCount} Classes`,              href: "/student/classes",             bg: "bg-white/10" },
                  { label: `${liveSessions.length} Live Now`,       href: "/student/classes",             bg: liveSessions.length > 0 ? "bg-white/25" : "bg-white/10" },
                  { label: `${todaySchedules.length} Today`,        href: "/student/lectures?scheduled=1", bg: "bg-white/10" },
                  { label: `${pendingAssignments.length} Pending`,  href: "/student/assignments?due=1",    bg: pendingAssignments.length > 0 ? "bg-amber-400/30" : "bg-white/10" },
                  { label: unpaidCount > 0 ? `${unpaidCount} Unpaid` : "Payments OK", href: "/student/payments", bg: unpaidCount > 0 ? "bg-rose-400/30" : "bg-white/15" },
                ].map(({ label, href, bg }) => (
                  <Link key={label} href={href} className={`rounded-full border border-white/10 px-3 py-1 text-xs font-semibold text-white transition hover:brightness-110 ${bg}`}>
                    {label}
                  </Link>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5 lg:min-w-[260px]">
              <Link href="/student/classes"      className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><BookOpen size={13} className="mx-auto mb-1" />Classes</Link>
              <Link href="/student/assignments"  className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><ClipboardList size={13} className="mx-auto mb-1" />Tasks</Link>
              <Link href="/student/papers" className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><FileText size={13} className="mx-auto mb-1" />Papers</Link>
              <Link href="/student/lectures"     className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><BookMarked size={13} className="mx-auto mb-1" />Lectures</Link>
              <Link href="/student/messages"     className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><MessageSquare size={13} className="mx-auto mb-1" />Messages</Link>
              <Link href="/student/attendance"   className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-center text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"><UserCheck size={13} className="mx-auto mb-1" />Attendance</Link>
            </div>
          </div>
        </section>

        {/* Upcoming countdowns (next 8 hours) */}
        <DashboardCountdowns items={upcomingCountdowns} />

        {/* Teacher confirmation pending / rejected */}
        {studentRecord?.confirmationStatus === "PENDING" && (
          <section className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <Clock size={16} />
            </span>
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Teacher confirmation is pending
              </p>
              <p className="mt-0.5 text-[13px] leading-5 text-amber-700">
                Your teacher hasn&apos;t approved your registration yet. They will
                confirm it soon &mdash; you&apos;ll get full access once they do.
              </p>
            </div>
          </section>
        )}
        {studentRecord?.confirmationStatus === "REJECTED" && (
          <section className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-700">
              <Clock size={16} />
            </span>
            <div>
              <p className="text-sm font-semibold text-red-900">
                Registration not approved
              </p>
              <p className="mt-0.5 text-[13px] leading-5 text-red-700">
                Your teacher did not approve this registration. Please contact
                your teacher for help.
              </p>
            </div>
          </section>
        )}

        {studentRecord?.status === 1 && (
          <section className="flex items-start gap-3 rounded-2xl border border-orange-200 bg-orange-50 p-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-orange-700">
              <Clock size={16} />
            </span>
            <div>
              <p className="text-sm font-semibold text-orange-900">
                Your teacher has deactivated your account
              </p>
              {studentRecord.deactivationReason && (
                <p className="mt-0.5 text-[13px] leading-5 text-orange-800">
                  <span className="font-medium">Reason:</span>{" "}
                  {studentRecord.deactivationReason}
                </p>
              )}
              <p className="mt-1 text-[13px] leading-5 text-orange-700">
                Please contact{" "}
                {studentRecord.teacher?.name ?? "your teacher"}
                {teacherContacts ? ` on ${teacherContacts}` : ""} to resolve
                this.
              </p>
            </div>
          </section>
        )}

        {/* 2. Live now — Jitsi sessions + YouTube broadcasts, pushed over SSE */}
        <LiveDashboardSection
          studentId={studentId}
          initialSessions={liveSessions.map((s) => ({
            id: s.id,
            className: s.class.name,
            teacherName: s.class.teacher.name,
            lectureTitle: s.lecture?.title ?? null,
            startedAt: s.startedAt.toISOString(),
            joinedCount: s._count.attendance,
          }))}
          initialBroadcasts={liveBroadcasts}
          initialCounts={dashboardCounts}
        />

        {/* Schedule + assignments due — realtime via SSE */}
        <DashboardAgenda />

        {/* Payment status — money due now and due later this month */}
        <DashboardPaymentStatus />

        {/* Unviewed lecture notes */}
        <DashboardStudyNotes />

        {/* Overall attendance % + quiz performance % */}
        <DashboardPerformance />

        {/* Messages + Paper Support */}
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
                  <Link key={delivery.id} href={`/student/messages?focus=${delivery.id}`} className="block rounded-xl border border-brand-100 bg-brand-50/40 px-4 py-3 transition-colors hover:border-brand-300 hover:bg-brand-50">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm font-medium text-foreground">{delivery.message.content}</p>
                      <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${delivery.status === "SENT" ? "bg-emerald-100 text-emerald-700" : delivery.status === "FAILED" ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-500"}`}>{delivery.status}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted">{delivery.message.class.name} &middot; {delivery.createdAt.toLocaleDateString()}</p>
                  </Link>
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
                  <Link key={msg.id} href="/student/messages#paper-support" className="block rounded-xl border border-violet-100 bg-violet-50/40 px-4 py-3 transition-colors hover:border-violet-300 hover:bg-violet-50">
                    <p className="line-clamp-2 text-sm text-foreground">{msg.message}</p>
                    <p className="mt-1 text-[11px] text-muted">{msg.class.name} &middot; {msg.item.title} &middot; {msg.createdAt.toLocaleDateString()}</p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>

      </div>
    </>
  );
}
