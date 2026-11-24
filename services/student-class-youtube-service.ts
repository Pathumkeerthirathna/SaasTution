/*
 * The student Recordings > Live Recordings and YouTube Live Sessions pages
 * (read-only): a class's YouTube classroom recordings (YouTubeRecording) and
 * YouTube live broadcasts (YouTubeLiveBroadcast), across the class or for one
 * of its normal lectures.
 *
 * Scope: an active class the student is actively enrolled in, optionally one
 * NORMAL active lecture of it (resolveStudentClassScope; never a default
 * lecture). Only active, normal lectures' items are listed.
 *
 * What a student may see (never a teacher field: no broadcast ids, stop
 * reasons, versions or errors):
 *  - recordings: the teacher's student visibility PUBLIC (exactly as the
 *    lecture detail route, GET /api/student/lectures/[id]) and never a
 *    YouTube-PRIVATE video (students cannot play it); the route adds the
 *    monthly resource lock per item and withholds a locked month's link;
 *  - live broadcasts: YouTube privacy PUBLIC or UNLISTED (never PRIVATE) that
 *    actually went live (LIVE, or COMPLETE / ended); the route refuses a
 *    payment-restricted class (403 CLASS_ACCESS_RESTRICTED), like the
 *    dashboard's live feed, which never hands out a restricted class's link.
 */

import type { Prisma, YouTubeBroadcastStatus } from "@prisma/client";

import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";
import { STUDENT_VISIBLE_PRIVACY_WHERE } from "@/lib/youtube-student-privacy";
import { resolveStudentClassScope } from "@/services/class-notes-service";

/** Lectures a listing may cover: active, normal (never the class's default lecture). */
function lectureFilter(classId: string, lectureId: string | null): Prisma.LectureWhereInput {
  return { classId, status: 0, ...NORMAL_LECTURE_WHERE, ...(lectureId ? { id: lectureId } : {}) };
}

const LECTURE_SELECT = { select: { id: true, title: true, date: true } } as const;


/** The broadcasts a student may see: ones that went live (live now, or finished). */
export const STUDENT_LIVE_STATUSES: YouTubeBroadcastStatus[] = ["LIVE", "COMPLETE"];

export type StudentScope = Awaited<ReturnType<typeof resolveStudentClassScope>>;

function scopeView(scope: StudentScope) {
  return {
    class: scope.class,
    lecture: scope.lecture ? { id: scope.lecture.id, title: scope.lecture.title, date: scope.lecture.date.toISOString() } : null,
  };
}

/** One page of the class's (or lecture's) student-visible YouTube recordings, newest first. 404 as resolveStudentClassScope. */
export async function listStudentClassYouTubeRecordings(input: {
  studentId: string;
  classId: string;
  lectureId: string | null;
  skip: number;
  take: number;
}) {
  const scope = await resolveStudentClassScope(input.studentId, input.classId, input.lectureId);
  const where: Prisma.YouTubeRecordingWhereInput = {
    visibility: "PUBLIC",
    ...STUDENT_VISIBLE_PRIVACY_WHERE,
    lecture: lectureFilter(scope.class.id, scope.lecture?.id ?? null),
  };
  const [total, rows] = await Promise.all([
    prisma.youTubeRecording.count({ where }),
    prisma.youTubeRecording.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: input.skip,
      take: input.take,
      select: {
        id: true,
        videoId: true,
        youtubeUrl: true,
        status: true,
        access: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        lecture: LECTURE_SELECT,
      },
    }),
  ]);
  return { ...scopeView(scope), total, rows };
}

/** One page of the class's (or lecture's) student-visible YouTube live broadcasts, newest first. 404 as resolveStudentClassScope. */
export async function listStudentClassYouTubeLives(input: {
  studentId: string;
  classId: string;
  lectureId: string | null;
  skip: number;
  take: number;
}) {
  const scope = await resolveStudentClassScope(input.studentId, input.classId, input.lectureId);
  const where: Prisma.YouTubeLiveBroadcastWhereInput = {
    ...STUDENT_VISIBLE_PRIVACY_WHERE,
    status: { in: STUDENT_LIVE_STATUSES },
    lecture: lectureFilter(scope.class.id, scope.lecture?.id ?? null),
  };
  const [total, rows] = await Promise.all([
    prisma.youTubeLiveBroadcast.count({ where }),
    prisma.youTubeLiveBroadcast.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: input.skip,
      take: input.take,
      select: {
        id: true,
        videoId: true,
        youtubeUrl: true,
        status: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        lecture: LECTURE_SELECT,
      },
    }),
  ]);
  return {
    ...scopeView(scope),
    total,
    broadcasts: rows.map((b) => ({
      id: b.id,
      videoId: b.videoId,
      youtubeUrl: b.youtubeUrl,
      // Live now: LIVE and not ended. Otherwise a finished broadcast (its replay).
      isLive: b.status === "LIVE" && b.endedAt === null,
      startedAt: b.startedAt ? b.startedAt.toISOString() : null,
      endedAt: b.endedAt ? b.endedAt.toISOString() : null,
      createdAt: b.createdAt.toISOString(),
      lecture: { id: b.lecture.id, title: b.lecture.title, date: b.lecture.date.toISOString() },
    })),
  };
}
