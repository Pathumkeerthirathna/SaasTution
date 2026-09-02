import { Weekday } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const WEEKDAY_INDEX: Record<Weekday, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export type CalendarEvent = {
  key: string;
  /** YYYY-MM-DD */
  date: string;
  startTime: string | null;
  endTime: string | null;
  kind: "schedule" | "event";

  // schedule entries
  classId: string | null;
  className: string;
  /** true = generated from a recurring class schedule. */
  scheduled: boolean;
  lecture: {
    id: string;
    title: string;
    status: string;
  } | null;

  // teacher event entries
  eventId: number | null;
  eventTypeName: string | null;
  color: string | null;
  description: string | null;
  isAllDay: boolean;
  location: string | null;
  meetingUrl: string | null;
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function timeKey(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

/**
 * Every calendar entry for a teacher between `from` and `to`:
 *  - one entry per recurring class-schedule occurrence in the window, carrying
 *    the matching lecture when one has been added for that day (otherwise the
 *    UI shows "lecture not added yet"),
 *  - plus any lecture that does not line up with a scheduled occurrence.
 */
export async function getTeacherCalendar(
  teacherId: string,
  from: Date,
  to: Date
): Promise<CalendarEvent[]> {
  const classes = await prisma.class.findMany({
    where: { teacherId, status: 0 },
    select: {
      id: true,
      name: true,
      startDate: true,
      schedules: {
        select: { dayOfWeek: true, startTime: true, endTime: true },
        orderBy: { startTime: "asc" },
      },
      lectures: {
        where: { status: 0, date: { gte: from, lte: to } },
        select: { id: true, title: true, classStatus: true, date: true },
        orderBy: { date: "asc" },
      },
    },
  });

  const events: CalendarEvent[] = [];

  const rangeStart = new Date(`${dayKey(from)}T00:00:00.000Z`);

  for (const cls of classes) {
    const lecturesByDay = new Map<
      string,
      { id: string; title: string; classStatus: string }[]
    >();

    for (const lecture of cls.lectures) {
      const key = dayKey(lecture.date);
      const list = lecturesByDay.get(key) ?? [];
      list.push({
        id: lecture.id,
        title: lecture.title,
        classStatus: lecture.classStatus,
      });
      lecturesByDay.set(key, list);
    }

    const usedLectureIds = new Set<string>();
    const startDateKey = cls.startDate ? dayKey(cls.startDate) : null;

    if (cls.schedules.length > 0) {
      for (
        let day = rangeStart;
        day.getTime() <= to.getTime();
        day = addUtcDays(day, 1)
      ) {
        const key = dayKey(day);

        if (startDateKey && key < startDateKey) {
          continue;
        }

        const dow = day.getUTCDay();
        const matches = cls.schedules.filter(
          (schedule) => WEEKDAY_INDEX[schedule.dayOfWeek] === dow
        );

        if (matches.length === 0) {
          continue;
        }

        const dayLectures = lecturesByDay.get(key) ?? [];

        for (const schedule of matches) {
          const lecture =
            dayLectures.find((item) => !usedLectureIds.has(item.id)) ??
            dayLectures[0] ??
            null;

          if (lecture) {
            usedLectureIds.add(lecture.id);
          }

          events.push({
            key: `${cls.id}-${key}-${schedule.startTime}`,
            date: key,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            kind: "schedule",
            classId: cls.id,
            className: cls.name,
            scheduled: true,
            lecture: lecture
              ? {
                  id: lecture.id,
                  title: lecture.title,
                  status: lecture.classStatus,
                }
              : null,
            eventId: null,
            eventTypeName: null,
            color: null,
            description: null,
            isAllDay: false,
            location: null,
            meetingUrl: null,
          });
        }
      }
    }

    // Lectures that did not match any scheduled occurrence.
    for (const lecture of cls.lectures) {
      if (usedLectureIds.has(lecture.id)) {
        continue;
      }

      events.push({
        key: `lecture-${lecture.id}`,
        date: dayKey(lecture.date),
        startTime: timeKey(lecture.date),
        endTime: null,
        kind: "schedule",
        classId: cls.id,
        className: cls.name,
        scheduled: false,
        lecture: {
          id: lecture.id,
          title: lecture.title,
          status: lecture.classStatus,
        },
        eventId: null,
        eventTypeName: null,
        color: null,
        description: null,
        isAllDay: false,
        location: null,
        meetingUrl: null,
      });
    }
  }

  // Teacher's own calendar events overlapping the window.
  const teacherEvents = await prisma.teacherCalendarEvent.findMany({
    where: {
      teacherId,
      status: 0,
      startDateTime: { lte: to },
      endDateTime: { gte: from },
    },
    orderBy: { startDateTime: "asc" },
    select: {
      id: true,
      title: true,
      description: true,
      startDateTime: true,
      endDateTime: true,
      isAllDay: true,
      location: true,
      meetingUrl: true,
      eventType: { select: { name: true, color: true } },
    },
  });

  for (const event of teacherEvents) {
    const firstDayKey = dayKey(
      event.startDateTime.getTime() < rangeStart.getTime()
        ? rangeStart
        : event.startDateTime
    );
    const lastDayKey = dayKey(
      event.endDateTime.getTime() > to.getTime() ? to : event.endDateTime
    );

    for (
      let day = new Date(`${firstDayKey}T00:00:00.000Z`);
      dayKey(day) <= lastDayKey;
      day = addUtcDays(day, 1)
    ) {
      const key = dayKey(day);
      const isFirst = key === dayKey(event.startDateTime);
      const isLast = key === dayKey(event.endDateTime);

      events.push({
        key: `event-${event.id}-${key}`,
        date: key,
        startTime: event.isAllDay || !isFirst ? null : timeKey(event.startDateTime),
        endTime: event.isAllDay || !isLast ? null : timeKey(event.endDateTime),
        kind: "event",
        classId: null,
        className: event.title,
        scheduled: false,
        lecture: null,
        eventId: event.id,
        eventTypeName: event.eventType.name,
        color: event.eventType.color,
        description: event.description,
        isAllDay: event.isAllDay,
        location: event.location,
        meetingUrl: event.meetingUrl,
      });
    }
  }

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.startTime ?? "").localeCompare(b.startTime ?? "");
  });

  return events;
}

export type StudentCalendarEntry = {
  key: string;
  /** YYYY-MM-DD */
  date: string;
  startTime: string | null;
  endTime: string | null;
  classId: string;
  className: string;
  teacherName: string;
  /** true = generated from a recurring class schedule. */
  scheduled: boolean;
  lecture: {
    id: string;
    title: string;
    status: string;
  } | null;
};

/**
 * Calendar entries for a student between `from` and `to`: one entry per
 * recurring class-schedule occurrence for each class the student is actively
 * enrolled in (carrying the lecture for that day when one exists), plus any
 * lecture that does not line up with a scheduled occurrence.
 */
export async function getStudentCalendar(
  studentId: string,
  from: Date,
  to: Date
): Promise<StudentCalendarEntry[]> {
  const classes = await prisma.class.findMany({
    where: {
      status: 0,
      students: { some: { studentId, isActive: true } },
    },
    select: {
      id: true,
      name: true,
      startDate: true,
      teacher: { select: { name: true } },
      schedules: {
        select: { dayOfWeek: true, startTime: true, endTime: true },
        orderBy: { startTime: "asc" },
      },
      lectures: {
        where: { status: 0, date: { gte: from, lte: to } },
        select: { id: true, title: true, classStatus: true, date: true },
        orderBy: { date: "asc" },
      },
    },
  });

  const entries: StudentCalendarEntry[] = [];
  const rangeStart = new Date(`${dayKey(from)}T00:00:00.000Z`);

  for (const cls of classes) {
    const teacherName = cls.teacher.name;

    const lecturesByDay = new Map<
      string,
      { id: string; title: string; classStatus: string }[]
    >();
    for (const lecture of cls.lectures) {
      const key = dayKey(lecture.date);
      const list = lecturesByDay.get(key) ?? [];
      list.push({ id: lecture.id, title: lecture.title, classStatus: lecture.classStatus });
      lecturesByDay.set(key, list);
    }

    const usedLectureIds = new Set<string>();
    const startDateKey = cls.startDate ? dayKey(cls.startDate) : null;

    if (cls.schedules.length > 0) {
      for (let day = rangeStart; day.getTime() <= to.getTime(); day = addUtcDays(day, 1)) {
        const key = dayKey(day);
        if (startDateKey && key < startDateKey) continue;

        const dow = day.getUTCDay();
        const matches = cls.schedules.filter(
          (schedule) => WEEKDAY_INDEX[schedule.dayOfWeek] === dow
        );
        if (matches.length === 0) continue;

        const dayLectures = lecturesByDay.get(key) ?? [];

        for (const schedule of matches) {
          const lecture =
            dayLectures.find((item) => !usedLectureIds.has(item.id)) ?? dayLectures[0] ?? null;
          if (lecture) usedLectureIds.add(lecture.id);

          entries.push({
            key: `${cls.id}-${key}-${schedule.startTime}`,
            date: key,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            classId: cls.id,
            className: cls.name,
            teacherName,
            scheduled: true,
            lecture: lecture
              ? { id: lecture.id, title: lecture.title, status: lecture.classStatus }
              : null,
          });
        }
      }
    }

    for (const lecture of cls.lectures) {
      if (usedLectureIds.has(lecture.id)) continue;
      entries.push({
        key: `lecture-${lecture.id}`,
        date: dayKey(lecture.date),
        startTime: timeKey(lecture.date),
        endTime: null,
        classId: cls.id,
        className: cls.name,
        teacherName,
        scheduled: false,
        lecture: { id: lecture.id, title: lecture.title, status: lecture.classStatus },
      });
    }
  }

  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.startTime ?? "").localeCompare(b.startTime ?? "");
  });

  return entries;
}
