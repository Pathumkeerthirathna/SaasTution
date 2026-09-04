import Link from "next/link";
import {
  CalendarDays,
  Clock,
  UserRound,
  Wallet,
  CalendarClock,
  LogIn,
  LogOut,
  FileText,
  ClipboardList,
  HelpCircle,
  ChevronRight,
} from "lucide-react";

import { StudentClassLiveBadge } from "@/components/student-portal/student-class-live-badge";
import { RealtimeRefresh } from "@/components/student-portal/realtime-refresh";
import {
  ClassBookBadge,
  getClassBookLabel,
  getClassCardIcon,
  getClassCardTheme,
  getClassNumber,
} from "@/components/class-card-visuals";
import { requireStudentSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { formatStoredSriLankaDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

function formatTime12h(value: string | null | undefined) {
  if (!value) return "";
  const [hRaw, mRaw] = value.split(":");
  const hour = Number(hRaw);
  if (Number.isNaN(hour)) return value;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${(mRaw ?? "00").padStart(2, "0")} ${suffix}`;
}

export default async function StudentClassesPage() {
  const studentSession = await requireStudentSession();

  const enrollments = await prisma.classStudent.findMany({
    where: {
      studentId: studentSession.studentId,
    },
    orderBy: {
      assignedAt: "desc",
    },
    select: {
      id: true,
      isActive: true,
      assignedAt: true,
      removedAt: true,
      removeReason: true,
      class: {
        select: {
          id: true,
          name: true,
          description: true,
          schedule: true,
          monthlyFee: true,
          paymentDueWeek: true,
          teacher: {
            select: {
              name: true,
            },
          },
          schedules: {
            select: {
              dayOfWeek: true,
              startTime: true,
              endTime: true,
            },
            orderBy: {
              dayOfWeek: "asc",
            },
          },
        },
      },
    },
  });

  const activeEnrollments = enrollments.filter((enrollment) => enrollment.isActive);
  const pastEnrollments = enrollments.filter((enrollment) => !enrollment.isActive);

  // Active live sessions for the classes this student is enrolled in.
  const liveSessions = await prisma.classSession.findMany({
    where: {
      isActive: true,
      class: { status: 0, students: { some: { studentId: studentSession.studentId, isActive: true } } },
      OR: [{ lectureId: null }, { lecture: { status: 0 } }],
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      startedAt: true,
      class: { select: { id: true } },
      lecture: { select: { title: true } },
    },
  });

  const liveSessionByClassId = new Map(liveSessions.map((session) => [session.class.id, session]));

  type Enrollment = (typeof enrollments)[number];

  function ClassCard({ enrollment, past }: { enrollment: Enrollment; past: boolean }) {
    const cls = enrollment.class;
    const theme = getClassCardTheme(cls.id);
    const ClassIcon = getClassCardIcon(cls.id);
    const bookLabel = getClassBookLabel(cls.name);
    const bookNumber = getClassNumber(cls.name);
    const schedules = cls.schedules ?? [];
    const live = liveSessionByClassId.get(cls.id);

    return (
      <article className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-lg">
        {/* Header */}
        <div className={`relative overflow-hidden bg-gradient-to-br ${theme.gradient} py-3 pl-4 text-white sm:pr-32 ${live && !past ? "pr-16" : "pr-4"}`}>
          <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full ${theme.glow1} blur-2xl`} />
          <div className={`pointer-events-none absolute -bottom-12 left-10 h-28 w-28 rounded-full ${theme.glow2} blur-2xl`} />

          {live && !past ? (
            <StudentClassLiveBadge
              className={cls.name}
              teacherName={cls.teacher.name}
              lectureTitle={live.lecture?.title ?? null}
              startedAtISO={live.startedAt.toISOString()}
              joinHref={`/session/join?sessionId=${live.id}&role=student&studentId=${studentSession.studentId}`}
            />
          ) : null}

          {/* Decorative book emblem — hidden on small screens so it never crowds the class details */}
          <div className="hidden sm:block">
            <ClassBookBadge
              label={bookLabel}
              number={bookNumber}
              bookGradient={theme.bookGradient}
              numberColor={theme.numberColor}
            />
          </div>

          <div className="relative flex items-start gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 shadow-inner backdrop-blur">
              <ClassIcon className={`h-4 w-4 ${theme.iconColor}`} />
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="break-words text-sm font-bold leading-tight tracking-tight text-white sm:truncate">
                  {cls.name}
                </h3>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border ${theme.badgeBorder} ${theme.badgeBg} px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${theme.badgeText}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${theme.badgeDot}`} />
                  {past ? "Past" : "Enrolled"}
                </span>
              </div>

              <div className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${theme.metaText}`}>
                <UserRound size={10} />
                {cls.teacher.name}
              </div>
            </div>
          </div>

          <div className="relative mt-2 flex items-center gap-1 border-t border-white/10 pt-2 text-[10px]">
            <LogIn size={10} className={theme.metaText} />
            <span className={theme.metaText}>Joined {formatStoredSriLankaDateTime(enrollment.assignedAt)}</span>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-3 p-3.5">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                <Wallet size={13} />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  {past ? "Fee at class" : "Monthly fee"}
                </p>
                <p className="truncate text-sm font-bold text-slate-900">
                  Rs {cls.monthlyFee.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-700">
                <CalendarDays size={13} />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Due week</p>
                <p className="truncate text-sm font-bold text-slate-900">Week {cls.paymentDueWeek}</p>
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <div className="flex h-5 w-5 items-center justify-center rounded-md bg-emerald-900/10">
                <CalendarClock className="h-3 w-3 text-emerald-800" />
              </div>
              <span className="text-xs font-semibold text-slate-800">Weekly schedule</span>
            </div>

            {schedules.length > 0 ? (
              <div className="space-y-1">
                {schedules.slice(0, 3).map((schedule) => (
                  <div
                    key={`${schedule.dayOfWeek}-${schedule.startTime}`}
                    className="flex items-center justify-between rounded-md border border-slate-100 bg-white px-2 py-1 shadow-sm"
                  >
                    <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                      {schedule.dayOfWeek}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-medium text-slate-500">
                      <Clock size={10} className="text-emerald-600" />
                      {formatTime12h(schedule.startTime)} - {formatTime12h(schedule.endTime)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">{cls.schedule || "Schedule not available"}</p>
            )}
          </div>

          {cls.description ? (
            <p className="line-clamp-2 text-xs leading-5 text-slate-600">{cls.description}</p>
          ) : null}

          {past ? (
            <div className="space-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
              <p className="flex items-center gap-1">
                <LogOut size={11} className="text-slate-400" />
                Removed {enrollment.removedAt ? formatStoredSriLankaDateTime(enrollment.removedAt) : "-"}
              </p>
              {enrollment.removeReason ? (
                <p className="text-slate-500">Reason: {enrollment.removeReason}</p>
              ) : null}
            </div>
          ) : null}

          {!past ? (
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-slate-100 pt-2">
              <Link
                href={`/student/lectures?classId=${cls.id}&scheduled=1`}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
              >
                <FileText size={11} />
                Lectures
              </Link>
              <Link
                href={`/student/assignments?classId=${cls.id}`}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:text-violet-900"
              >
                <ClipboardList size={11} />
                Assignments
              </Link>
              <Link
                href={`/student/quizzes?classId=${cls.id}`}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 hover:text-sky-900"
              >
                <HelpCircle size={11} />
                Quizzes
              </Link>
              <Link
                href={`/student/payments?classId=${cls.id}`}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 hover:text-teal-900"
              >
                <Wallet size={11} />
                Payments
                <ChevronRight size={11} className="text-slate-400" />
              </Link>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <>
      <RealtimeRefresh events={["counts-stale", "sessions", "broadcasts"]} />
      <section>
        {enrollments.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
            You are not enrolled in any classes yet.
          </div>
        ) : (
          <div className="space-y-6">
            <section>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Active Classes ({activeEnrollments.length})
              </h3>
              {activeEnrollments.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No active classes right now.</p>
              ) : (
                <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {activeEnrollments.map((enrollment) => (
                    <ClassCard key={enrollment.id} enrollment={enrollment} past={false} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Past Classes ({pastEnrollments.length})
              </h3>
              {pastEnrollments.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No past class records yet.</p>
              ) : (
                <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {pastEnrollments.map((enrollment) => (
                    <ClassCard key={enrollment.id} enrollment={enrollment} past />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </section>
    </>
  );
}
