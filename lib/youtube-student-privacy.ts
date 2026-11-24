import type { YouTubePrivacy } from "@prisma/client";

/*
 * Which YouTube privacies a student (or a public visitor) may ever be given:
 * PUBLIC and UNLISTED. A YouTube PRIVATE recording or broadcast is never
 * listed, counted or linked for them (no video id, URL, embed or playback):
 * it is filtered in the database query of every student / public entry point:
 *  - GET /api/student/lectures (recording counts) and /api/student/lectures/[id]
 *  - GET /api/student/classes/[id]/youtube-recordings | youtube-lives
 *  - the student dashboard / live feed (lib/youtube-live-status.ts, student mode)
 *  - the live classroom status (lib/youtube-live-snapshot.ts, student audience)
 *  - the public class pages (services/class-service.ts getPublicClassSessions)
 * The teacher's own views and workflows are unaffected (they see every privacy).
 * Guarded by tests/students/student-youtube-privacy.test.cjs.
 */

export const STUDENT_VISIBLE_YOUTUBE_PRIVACIES: YouTubePrivacy[] = ["PUBLIC", "UNLISTED"];

/** The Prisma filter for a student-visible recording / broadcast. */
export const STUDENT_VISIBLE_PRIVACY_WHERE = { privacy: { in: STUDENT_VISIBLE_YOUTUBE_PRIVACIES } };

export function isStudentVisibleYouTubePrivacy(privacy: string): boolean {
  return (STUDENT_VISIBLE_YOUTUBE_PRIVACIES as string[]).includes(privacy);
}
