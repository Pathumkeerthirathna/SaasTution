import { StudentYouTubePage } from "@/components/student-portal/recordings/student-youtube-page";

export const dynamic = "force-dynamic";

/**
 * Recordings > YouTube Live Sessions: the YouTube live streams of the
 * student's classes, live now or their replays (read-only;
 * GET /api/student/classes/[id]/youtube-lives).
 */
export default function StudentYouTubeLiveSessionsPage({ searchParams }: { searchParams?: { classId?: string | string[] } }) {
  return <StudentYouTubePage kind="lives" searchParams={searchParams} />;
}
