import { notFound, redirect } from "next/navigation";

import { RecordingStudioClient } from "@/components/recorded-lectures/recording-studio-client";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError } from "@/lib/error-handler";
import { listTeacherLectureRecordings } from "@/services/recorded-lecture-teacher-service";

export const dynamic = "force-dynamic";

/*
 * Teacher: the browser Recording Studio for one lecture. The recording is
 * saved as a new part through the normal upload protocol, only after the
 * teacher has reviewed it.
 */
export default async function RecordingStudioPage({ params }: { params: { lectureId: string } }) {
  let teacherId: string;
  try {
    teacherId = (await requireTeacherSession()).teacherId;
  } catch {
    redirect("/dashboard");
  }
  try {
    const data = await listTeacherLectureRecordings({ teacherId, lectureId: params.lectureId });
    return (
      <div className="w-full pb-6">
        <RecordingStudioClient
          teacherId={teacherId}
          lecture={{ id: data.lecture.id, title: data.lecture.title, className: data.lecture.className }}
          nextPartNumber={data.nextPartNumber}
          maxMoovBytes={data.limits.maxMoovBytes}
        />
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
