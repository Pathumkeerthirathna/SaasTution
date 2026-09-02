import { prisma } from "@/lib/prisma";
import { getActiveYouTubeLives, type LiveBroadcastView } from "@/lib/youtube-live-status";

export type LiveSessionView = {
  id: string;
  className: string;
  teacherName: string;
  lectureTitle: string | null;
  startedAt: string;
  joinedCount: number;
};

export async function getStudentClassIds(studentId: string): Promise<string[]> {
  const rows = await prisma.classStudent.findMany({
    where: { studentId, isActive: true, class: { status: 0 } },
    select: { classId: true },
  });
  return [...new Set(rows.map((r) => r.classId))];
}

/** The Jitsi live sessions currently running for the student's classes. */
export async function getStudentLiveSessions(studentId: string): Promise<LiveSessionView[]> {
  const sessions = await prisma.classSession.findMany({
    where: {
      isActive: true,
      class: { status: 0, students: { some: { studentId, isActive: true } } },
      OR: [{ lectureId: null }, { lecture: { status: 0 } }],
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      startedAt: true,
      class: { select: { name: true, teacher: { select: { name: true } } } },
      lecture: { select: { title: true } },
      _count: { select: { attendance: { where: { student: { status: 0 } } } } },
    },
  });

  return sessions.map((s) => ({
    id: s.id,
    className: s.class.name,
    teacherName: s.class.teacher.name,
    lectureTitle: s.lecture?.title ?? null,
    startedAt: s.startedAt.toISOString(),
    joinedCount: s._count.attendance,
  }));
}

export async function getStudentLiveBroadcasts(studentId: string): Promise<LiveBroadcastView[]> {
  return getActiveYouTubeLives({ studentId });
}
