import { notFound } from "next/navigation";

import { RecordingPlayer } from "@/components/student-portal/recorded-lectures/recording-player";
import { requireStudentSession } from "@/lib/auth-session";
import { loadLecturePlayer } from "@/services/recorded-lecture-student-pages";
import { lockedResourceMessage, monthKey } from "@/services/resource-access-service";

export const dynamic = "force-dynamic";

/*
 * The recorded lecture player (RL-5.1):
 *   /student/recorded-lectures/<lectureId>?recording=<recordingId>
 * All parts of the lecture are loaded here on the server (RL-4.2 access
 * filter); the video streams from each part's RL-4.3 streamUrl. A lecture
 * the student cannot see (or with no visible part) is a 404.
 *
 * Monthly resource access (services/resource-access-service.ts): parts of a
 * locked billing month are never given to the player (they carry no
 * streamUrl, and the stream route refuses them); the page explains each
 * locked month instead.
 */

type PageProps = {
  params: { lectureId: string };
  searchParams: { [key: string]: string | string[] | undefined };
};

export default async function StudentRecordedLecturePlayerPage({ params, searchParams }: PageProps) {
  const session = await requireStudentSession();
  const page = await loadLecturePlayer(session.studentId, params.lectureId);
  if (!page.ok) {
    if (page.reason === "UNAVAILABLE") {
      return (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Recorded lectures are temporarily unavailable. Please try again later.
        </p>
      );
    }
    notFound();
  }
  const requested = typeof searchParams.recording === "string" ? searchParams.recording : null;

  const playable = page.parts.filter((part) => !part.resourceAccess?.locked);
  const lockedMonths = new Map<string, { year: number; month: number }>();
  for (const part of page.parts) {
    if (part.resourceAccess?.locked) lockedMonths.set(monthKey(part.resourceAccess), part.resourceAccess);
  }
  // The same server-side decision as the stream route (the resolver the
  // parts were marked with: no further query), for the explanation.
  const lockedMessages: string[] = [];
  for (const month of lockedMonths.values()) {
    const decision = page.access.decide(page.class.id, month);
    if (decision && !decision.accessible) lockedMessages.push(lockedResourceMessage(decision));
  }

  return (
    <section className="space-y-3 rounded-xl border border-brand-200 bg-white p-3 shadow-card sm:p-4">
      {lockedMessages.length > 0 ? (
        <div role="alert" data-locked-recordings className="space-y-1 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          {lockedMessages.map((message) => (
            <p key={message}>{message}</p>
          ))}
          {playable.length > 0 ? <p className="text-xs text-rose-800">The other parts of this lecture are available below.</p> : null}
        </div>
      ) : null}
      {playable.length > 0 ? (
        <RecordingPlayer
          // A different lecture is a fresh player (its own parts and state).
          key={page.lecture.id}
          studentId={session.studentId}
          lecture={page.lecture}
          isGeneral={page.isGeneral}
          classInfo={page.class}
          initialParts={playable}
          initialNextCursor={page.nextCursor}
          requestedRecordingId={requested}
        />
      ) : null}
    </section>
  );
}
