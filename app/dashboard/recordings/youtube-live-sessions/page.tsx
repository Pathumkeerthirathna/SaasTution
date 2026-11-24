import { redirect } from "next/navigation";

import { YouTubeLectureWorkspace } from "@/components/youtube/youtube-lecture-workspace";
import { requireTeacherSession } from "@/lib/auth-session";
import { loadYouTubeLectureSelection } from "../_lib/youtube-lecture-selection";

export const dynamic = "force-dynamic";

type PageProps = { searchParams?: { [key: string]: string | string[] | undefined } };

/**
 * Recordings > YouTube Live Sessions: one lecture's YouTube live streams
 * (components/youtube/lecture-live-broadcasts-panel.tsx, the same panel as a
 * lecture card's "Live Streams"). The teacher's classes and an optional
 * ?classId= / ?lectureId= are checked on the server
 * (_lib/youtube-lecture-selection.ts); the per-lecture API checks ownership
 * again on every request.
 */
export default async function YouTubeLiveSessionsPage({ searchParams }: PageProps) {
  let teacherId: string;
  try {
    teacherId = (await requireTeacherSession()).teacherId;
  } catch {
    redirect("/dashboard");
  }
  const selection = await loadYouTubeLectureSelection(teacherId, searchParams);
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <YouTubeLectureWorkspace kind="lives" classes={selection.classes} initialClassId={selection.initialClassId} initialLectureId={selection.initialLectureId} />
    </div>
  );
}
