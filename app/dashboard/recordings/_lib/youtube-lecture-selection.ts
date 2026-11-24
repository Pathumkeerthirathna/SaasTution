import "server-only";

import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";

/*
 * The Recordings > YouTube Live Sessions / Live Recordings pages' server-side
 * selection: the signed-in teacher's ACTIVE classes, and the optional
 * ?classId= / ?lectureId= (links from a lecture's context) accepted only when
 * they are one of those classes and a NORMAL, active lecture of that class
 * (never a class's default lecture). Anything else is ignored, never trusted.
 * (A "_lib" folder: not a route.)
 */

export type YouTubeSelectionClass = { id: string; name: string };

export type YouTubeLectureSelection = {
  classes: YouTubeSelectionClass[];
  initialClassId: string | null;
  initialLectureId: string | null;
};

type SearchParams = { [key: string]: string | string[] | undefined } | undefined;

const one = (value: string | string[] | undefined): string | null => (typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null);

export async function loadYouTubeLectureSelection(teacherId: string, searchParams: SearchParams): Promise<YouTubeLectureSelection> {
  const classes = await prisma.class.findMany({
    where: { teacherId, status: 0 },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });

  const requestedClass = one(searchParams?.classId);
  const initialClassId = requestedClass && classes.some((c) => c.id === requestedClass) ? requestedClass : null;

  const requestedLecture = initialClassId ? one(searchParams?.lectureId) : null;
  const lecture = requestedLecture
    ? await prisma.lecture.findFirst({
        where: { id: requestedLecture, classId: initialClassId!, status: 0, ...NORMAL_LECTURE_WHERE, class: { teacherId, status: 0 } },
        select: { id: true },
      })
    : null;

  return { classes, initialClassId, initialLectureId: lecture?.id ?? null };
}
