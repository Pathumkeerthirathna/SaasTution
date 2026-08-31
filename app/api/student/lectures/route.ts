import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const WEEKDAY_NAMES = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseTime(value: string): [number, number] {
  const [h, m] = value.split(":").map(Number);
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
}

type ListItem =
  | {
      kind: "lecture";
      id: string;
      title: string;
      date: string;
      className: string;
      classId: string;
      startTime: string | null;
      endTime: string | null;
      noteCount: number;
      assignmentCount: number;
      recordingCount: number;
    }
  | {
      kind: "schedule";
      id: string;
      date: string;
      className: string;
      classId: string;
      startTime: string;
      endTime: string;
    };

// GET /api/student/lectures
// Query: page, limit, classId, from (date), to (date)
// Returns a combined, date-descending list of the student's lectures plus
// class-schedule occurrences that do not yet have a lecture attached.
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") ?? "10", 10)));
    const classId = url.searchParams.get("classId") || undefined;
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    // "scheduled" → only real lecture rows; skip the not-yet-added schedule slots.
    const scheduledOnly = ["1", "true", "yes"].includes(
      (url.searchParams.get("scheduled") ?? "").toLowerCase()
    );

    const now = new Date();
    const fromDate = fromParam ? new Date(`${fromParam}T00:00:00.000`) : null;
    const toDate = toParam ? new Date(`${toParam}T23:59:59.999`) : null;

    // Schedule occurrences need a bounded window. When the caller passes no
    // range ("All"), fall back to a ±45-day window around today.
    const schedFrom = fromDate ?? new Date(now.getTime() - 45 * DAY_MS);
    const schedTo = toDate ?? new Date(now.getTime() + 45 * DAY_MS);

    const enrollmentFilter = {
      class: {
        status: 0,
        students: {
          some: { studentId: session.studentId, isActive: true },
        },
      },
    } as const;

    const lectureWhere = {
      ...enrollmentFilter,
      status: 0,
      ...(classId ? { classId } : {}),
      ...(fromDate || toDate
        ? {
            date: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [lectures, dedupeLectures, schedules, enrolledClassStudents] = await Promise.all([
      prisma.lecture.findMany({
        where: lectureWhere,
        orderBy: { date: "desc" },
        select: {
          id: true,
          title: true,
          date: true,
          classId: true,
          class: { select: { id: true, name: true } },
          _count: {
            select: {
              notes: { where: { status: 0 } },
              assignments: { where: { status: 0 } },
              youtubeRecordings: { where: { visibility: "PUBLIC" } },
            },
          },
        },
      }),
      // All lectures inside the schedule window (any page) — used to know which
      // schedule occurrences already have a lecture.
      prisma.lecture.findMany({
        where: {
          ...enrollmentFilter,
          status: 0,
          ...(classId ? { classId } : {}),
          date: { gte: schedFrom, lte: schedTo },
        },
        select: { classId: true, date: true },
      }),
      prisma.classSchedule.findMany({
        where: {
          class: {
            status: 0,
            students: { some: { studentId: session.studentId, isActive: true } },
          },
          ...(classId ? { classId } : {}),
        },
        select: {
          id: true,
          classId: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          class: { select: { id: true, name: true } },
        },
      }),
      prisma.classStudent.findMany({
        where: { studentId: session.studentId, isActive: true },
        select: { class: { select: { id: true, name: true } } },
        orderBy: { class: { name: "asc" } },
      }),
    ]);

    const lectureDayKeys = new Set(
      dedupeLectures.map((l) => `${l.classId}|${ymd(l.date)}`)
    );

    // Match a schedule (by class + weekday) so lecture rows can show their time.
    const scheduleByClassDay = new Map<string, { startTime: string; endTime: string }>();
    for (const s of schedules) {
      scheduleByClassDay.set(`${s.classId}|${s.dayOfWeek}`, {
        startTime: s.startTime,
        endTime: s.endTime,
      });
    }

    const lectureItems: ListItem[] = [];
    const scheduleItems: ListItem[] = [];

    for (const l of lectures) {
      const weekday = WEEKDAY_NAMES[l.date.getDay()];
      const match = scheduleByClassDay.get(`${l.classId}|${weekday}`) ?? null;
      lectureItems.push({
        kind: "lecture",
        id: l.id,
        title: l.title,
        date: l.date.toISOString(),
        className: l.class.name,
        classId: l.class.id,
        startTime: match?.startTime ?? null,
        endTime: match?.endTime ?? null,
        noteCount: l._count.notes,
        assignmentCount: l._count.assignments,
        recordingCount: l._count.youtubeRecordings,
      });
    }

    // Generate schedule occurrences in [schedFrom, schedTo] with no lecture.
    // The window is capped at ~13 months so an absurd custom range cannot blow up.
    const windowStart = new Date(schedFrom);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(
      Math.min(schedTo.getTime(), windowStart.getTime() + 400 * DAY_MS)
    );

    for (const s of scheduledOnly ? [] : schedules) {
      const targetDow = WEEKDAY_NAMES.indexOf(s.dayOfWeek);
      if (targetDow < 0) continue;
      const [h, m] = parseTime(s.startTime);

      const occ = new Date(windowStart);
      occ.setDate(occ.getDate() + ((targetDow - occ.getDay() + 7) % 7));

      for (; occ.getTime() <= windowEnd.getTime(); occ.setDate(occ.getDate() + 7)) {
        const key = `${s.classId}|${ymd(occ)}`;
        if (lectureDayKeys.has(key)) continue;

        const occAt = new Date(occ);
        occAt.setHours(h, m, 0, 0);

        scheduleItems.push({
          kind: "schedule",
          id: `sch-${s.id}-${ymd(occ)}`,
          date: occAt.toISOString(),
          className: s.class.name,
          classId: s.class.id,
          startTime: s.startTime,
          endTime: s.endTime,
        });
      }
    }

    // Lectures first, newest → oldest; then not-yet-added schedule slots,
    // soonest → latest.
    lectureItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    scheduleItems.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const items: ListItem[] = [...lectureItems, ...scheduleItems];

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const pageItems = items.slice(start, start + limit);

    return apiSuccess({
      items: pageItems,
      enrolledClasses: enrolledClassStudents.map((cs) => ({
        id: cs.class.id,
        name: cs.class.name,
      })),
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
