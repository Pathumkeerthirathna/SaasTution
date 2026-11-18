import { notFound } from "next/navigation";

import { RecordingPlayer } from "@/components/student-portal/recorded-lectures/recording-player";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError } from "@/lib/error-handler";
import { assertContentAccessForStudent, CLASS_ACCESS_RESTRICTED } from "@/services/class-access-service";
import { loadLecturePlayer } from "@/services/recorded-lecture-student-pages";

export const dynamic = "force-dynamic";

/*
 * The recorded lecture player (RL-5.1):
 *   /student/recorded-lectures/<lectureId>?recording=<recordingId>
 * All parts of the lecture are loaded here on the server (RL-4.2 access
 * filter); the video streams from each part's RL-4.3 streamUrl. A lecture
 * the student cannot see (or with no visible part) is a 404.
 */

type PageProps = {
  params: { lectureId: string };
  searchParams: { [key: string]: string | string[] | undefined };
};

export default async function StudentRecordedLecturePlayerPage({ params, searchParams }: PageProps) {
  const session = await requireStudentSession();
  // Payment-due access control: the stream itself is refused (403) as well;
  // here the student gets the explanation instead of a player that cannot play.
  try {
    await assertContentAccessForStudent(session.studentId, { lectureId: params.lectureId });
  } catch (error) {
    if (error instanceof AppError && error.code === CLASS_ACCESS_RESTRICTED) {
      return (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {error.message}
        </p>
      );
    }
    throw error;
  }
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

  return (
    <section className="rounded-xl border border-brand-200 bg-white p-3 shadow-card sm:p-4">
      <RecordingPlayer
        // A different lecture is a fresh player (its own parts and state).
        key={page.lecture.id}
        studentId={session.studentId}
        lecture={page.lecture}
        classInfo={page.class}
        initialParts={page.parts}
        initialNextCursor={page.nextCursor}
        requestedRecordingId={requested}
      />
    </section>
  );
}
