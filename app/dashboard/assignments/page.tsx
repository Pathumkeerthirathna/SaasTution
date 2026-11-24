import { redirect } from "next/navigation";

import { ClassCourseworkWorkspace } from "@/components/coursework/class-coursework-workspace";
import { requireTeacherSession } from "@/lib/auth-session";
import { loadTeacherClassLectureSelection } from "@/lib/teacher-class-lecture-selection";

export const dynamic = "force-dynamic";

type PageProps = { searchParams?: { [key: string]: string | string[] | undefined } };

/**
 * The teacher's Assignments page: a class's General Assignments (no lecture)
 * or one normal lecture's assignments, managed by the existing assignment
 * panel through GET / POST /api/classes/[id]/assignments
 * (components/coursework/class-coursework-workspace.tsx). The teacher's
 * classes and an optional ?classId= / ?lectureId= are checked on the server;
 * every API checks ownership again.
 */
export default async function TeacherAssignmentsPage({ searchParams }: PageProps) {
  let teacherId: string;
  try {
    teacherId = (await requireTeacherSession()).teacherId;
  } catch {
    redirect("/dashboard");
  }
  const selection = await loadTeacherClassLectureSelection(teacherId, searchParams);
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <ClassCourseworkWorkspace kind="assignments" classes={selection.classes} initialClassId={selection.initialClassId} initialLectureId={selection.initialLectureId} />
    </div>
  );
}
