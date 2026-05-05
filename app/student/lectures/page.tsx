import { LectureListClient } from "@/components/student-portal/lecture-list-client";
import { Panel } from "@/components/student-portal/student-ui";
import { requireStudentSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export default async function StudentLecturesPage() {
  await requireStudentSession();

  return (
    <Panel title="Lectures / Notes" subtitle="Browse lecture materials uploaded by your teachers.">
      <LectureListClient />
    </Panel>
  );
}
