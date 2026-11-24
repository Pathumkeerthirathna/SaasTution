import { redirect } from "next/navigation";

import { TeacherRecordingsWorkspace } from "@/components/recorded-lectures/teacher-recordings-workspace";
import { requireTeacherSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

/**
 * Recordings > Recorded Lectures: a class's General Recordings and its
 * lectures' recordings (components/recorded-lectures/teacher-recordings-workspace.tsx).
 * The teacher id is only used by the browser to remember resumable uploads;
 * every request is authorised again by the APIs (class ownership, normal
 * lectures, upload ownership). The former /dashboard/recorded-lectures
 * redirects here.
 */
export default async function RecordingsRecordedLecturesPage() {
  let teacherId: string;
  try {
    teacherId = (await requireTeacherSession()).teacherId;
  } catch {
    redirect("/dashboard");
  }
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <TeacherRecordingsWorkspace teacherId={teacherId} />
    </div>
  );
}
