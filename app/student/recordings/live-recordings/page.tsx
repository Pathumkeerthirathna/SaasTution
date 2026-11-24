import { StudentYouTubePage } from "@/components/student-portal/recordings/student-youtube-page";

export const dynamic = "force-dynamic";

/**
 * Recordings > Live Recordings: the YouTube recordings of the student's live
 * classes (read-only; GET /api/student/classes/[id]/youtube-recordings).
 */
export default function StudentLiveRecordingsPage({ searchParams }: { searchParams?: { classId?: string | string[] } }) {
  return <StudentYouTubePage kind="recordings" searchParams={searchParams} />;
}
