import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";

const DEFAULT_EVENT_TYPES: { name: string; color: string }[] = [
  { name: "Meeting", color: "#3B82F6" },
  { name: "Exam", color: "#EF4444" },
  { name: "Workshop", color: "#8B5CF6" },
  { name: "Holiday", color: "#10B981" },
  { name: "Other", color: "#64748B" },
];

export type EventTypeDto = {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  isActive: boolean;
  eventCount: number;
};

const typeSelect = {
  id: true,
  name: true,
  description: true,
  color: true,
  isActive: true,
  _count: { select: { events: true } },
} as const;

function toTypeDto(row: {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  isActive: boolean;
  _count: { events: number };
}): EventTypeDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    isActive: row.isActive,
    eventCount: row._count.events,
  };
}

/**
 * Every event type for the teacher. On first use the standard set is seeded:
 * Meeting, Exam, Workshop, Holiday, Other.
 */
export async function getTeacherEventTypes(
  teacherId: string
): Promise<EventTypeDto[]> {
  const count = await prisma.teacherEventType.count({ where: { teacherId } });

  if (count === 0) {
    await prisma.teacherEventType.createMany({
      data: DEFAULT_EVENT_TYPES.map((type) => ({
        teacherId,
        name: type.name,
        color: type.color,
      })),
      skipDuplicates: true,
    });
  }

  const rows = await prisma.teacherEventType.findMany({
    where: { teacherId },
    orderBy: { name: "asc" },
    select: typeSelect,
  });

  return rows.map(toTypeDto);
}

export async function createTeacherEventType(
  teacherId: string,
  input: { name: string; description?: string | null; color?: string | null }
): Promise<EventTypeDto> {
  const name = input.name?.trim();

  if (!name) {
    throw new AppError("Event type name is required.", 400, "VALIDATION_ERROR");
  }

  const existing = await prisma.teacherEventType.findUnique({
    where: { teacherId_name: { teacherId, name } },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(
      "You already have an event type with this name.",
      409,
      "DUPLICATE"
    );
  }

  const row = await prisma.teacherEventType.create({
    data: {
      teacherId,
      name,
      description: input.description?.trim() || null,
      color: input.color?.trim() || null,
    },
    select: typeSelect,
  });

  return toTypeDto(row);
}

export async function updateTeacherEventType(
  teacherId: string,
  id: number,
  input: {
    name?: string;
    description?: string | null;
    color?: string | null;
    isActive?: boolean;
  }
): Promise<EventTypeDto> {
  const owned = await prisma.teacherEventType.findFirst({
    where: { id, teacherId },
    select: { id: true },
  });

  if (!owned) {
    throw new AppError("Event type not found.", 404, "NOT_FOUND");
  }

  const data: {
    name?: string;
    description?: string | null;
    color?: string | null;
    isActive?: boolean;
  } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      throw new AppError("Event type name is required.", 400, "VALIDATION_ERROR");
    }
    data.name = name;
  }

  if (input.description !== undefined) {
    data.description = input.description?.trim() || null;
  }

  if (input.color !== undefined) {
    data.color = input.color?.trim() || null;
  }

  if (input.isActive !== undefined) {
    data.isActive = input.isActive;
  }

  try {
    const row = await prisma.teacherEventType.update({
      where: { id },
      data,
      select: typeSelect,
    });
    return toTypeDto(row);
  } catch {
    throw new AppError(
      "You already have an event type with this name.",
      409,
      "DUPLICATE"
    );
  }
}

export async function deleteTeacherEventType(
  teacherId: string,
  id: number
): Promise<{ success: true; softDeleted: boolean }> {
  const type = await prisma.teacherEventType.findFirst({
    where: { id, teacherId },
    select: { id: true, _count: { select: { events: true } } },
  });

  if (!type) {
    throw new AppError("Event type not found.", 404, "NOT_FOUND");
  }

  // Keep past events intact: a type still in use is hidden, not deleted.
  if (type._count.events > 0) {
    await prisma.teacherEventType.update({
      where: { id },
      data: { isActive: false },
    });
    return { success: true, softDeleted: true };
  }

  await prisma.teacherEventType.delete({ where: { id } });
  return { success: true, softDeleted: false };
}

export type CalendarEventInput = {
  eventTypeId: number;
  title: string;
  description?: string | null;
  startDateTime: string;
  endDateTime: string;
  isAllDay?: boolean;
  location?: string | null;
  meetingUrl?: string | null;
};

async function assertTypeBelongsToTeacher(teacherId: string, eventTypeId: number) {
  const type = await prisma.teacherEventType.findFirst({
    where: { id: eventTypeId, teacherId },
    select: { id: true },
  });

  if (!type) {
    throw new AppError("Event type not found.", 400, "VALIDATION_ERROR");
  }
}

function parseRange(startRaw: string, endRaw: string) {
  const start = new Date(startRaw);
  const end = new Date(endRaw);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError("Start and end must be valid dates.", 400, "VALIDATION_ERROR");
  }

  if (end.getTime() < start.getTime()) {
    throw new AppError("End must not be before start.", 400, "VALIDATION_ERROR");
  }

  return { start, end };
}

export async function createTeacherCalendarEvent(
  teacherId: string,
  input: CalendarEventInput
) {
  const title = input.title?.trim();

  if (!title) {
    throw new AppError("Event title is required.", 400, "VALIDATION_ERROR");
  }

  await assertTypeBelongsToTeacher(teacherId, input.eventTypeId);
  const { start, end } = parseRange(input.startDateTime, input.endDateTime);

  return prisma.teacherCalendarEvent.create({
    data: {
      teacherId,
      eventTypeId: input.eventTypeId,
      title,
      description: input.description?.trim() || null,
      startDateTime: start,
      endDateTime: end,
      isAllDay: Boolean(input.isAllDay),
      location: input.location?.trim() || null,
      meetingUrl: input.meetingUrl?.trim() || null,
    },
  });
}

export async function updateTeacherCalendarEvent(
  teacherId: string,
  id: number,
  input: Partial<CalendarEventInput>
) {
  const owned = await prisma.teacherCalendarEvent.findFirst({
    where: { id, teacherId },
    select: { id: true, startDateTime: true, endDateTime: true },
  });

  if (!owned) {
    throw new AppError("Event not found.", 404, "NOT_FOUND");
  }

  if (input.eventTypeId !== undefined) {
    await assertTypeBelongsToTeacher(teacherId, input.eventTypeId);
  }

  const data: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) {
      throw new AppError("Event title is required.", 400, "VALIDATION_ERROR");
    }
    data.title = title;
  }

  if (input.eventTypeId !== undefined) data.eventTypeId = input.eventTypeId;
  if (input.description !== undefined)
    data.description = input.description?.trim() || null;
  if (input.isAllDay !== undefined) data.isAllDay = Boolean(input.isAllDay);
  if (input.location !== undefined) data.location = input.location?.trim() || null;
  if (input.meetingUrl !== undefined)
    data.meetingUrl = input.meetingUrl?.trim() || null;

  if (input.startDateTime !== undefined || input.endDateTime !== undefined) {
    const { start, end } = parseRange(
      input.startDateTime ?? owned.startDateTime.toISOString(),
      input.endDateTime ?? owned.endDateTime.toISOString()
    );
    data.startDateTime = start;
    data.endDateTime = end;
  }

  return prisma.teacherCalendarEvent.update({ where: { id }, data });
}

export async function deleteTeacherCalendarEvent(teacherId: string, id: number) {
  const owned = await prisma.teacherCalendarEvent.findFirst({
    where: { id, teacherId },
    select: { id: true },
  });

  if (!owned) {
    throw new AppError("Event not found.", 404, "NOT_FOUND");
  }

  await prisma.teacherCalendarEvent.delete({ where: { id } });
  return { success: true };
}
