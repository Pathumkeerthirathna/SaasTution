import { notFound, redirect } from "next/navigation";

import { TeacherRecordingsClient } from "@/components/recorded-lectures/teacher-recordings-client";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError } from "@/lib/error-handler";
import { listTeacherLectureRecordings } from "@/services/recorded-lecture-teacher-service";

export const dynamic = "force-dynamic";

/*
 * Teacher: one lecture's recorded lectures (manage, upload, preview, delete).
 * The data is loaded here through the same ownership-checked service as the
 * API; a lecture that is not the teacher's own active lecture is a 404.
 */
export default async function LectureRecordingsPage({ params }: { params: { lectureId: string } }) {
  let teacherId: string;
  try {
    teacherId = (await requireTeacherSession()).teacherId;
  } catch {
    redirect("/dashboard");
  }
  try {
    const initial = await listTeacherLectureRecordings({ teacherId, lectureId: params.lectureId });
    return (
      <div className="w-full pb-6">
        <TeacherRecordingsClient teacherId={teacherId} initial={initial} />
      </div>
    );
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) notFound();
    if (error instanceof AppError && error.statusCode === 503) {
      return (
        <p role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Recorded lectures are not available right now. Please try again later.
        </p>
      );
    }
    throw error;
  }
}
