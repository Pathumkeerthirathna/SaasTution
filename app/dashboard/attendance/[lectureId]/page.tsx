import dynamic from "next/dynamic";
import { Suspense } from "react";

const LectureAttendanceRegisterPanel = dynamic(
  () => import("@/components/attendance/lecture-attendance-register-panel").then((mod) => mod.LectureAttendanceRegisterPanel),
  { loading: () => <div className="mt-6 text-sm text-muted">Loading the attendance register...</div> }
);

/**
 * The attendance register of one lecture (read only). The dashboard layout
 * and middleware require a signed-in teacher; the API decides whether this
 * lecture is theirs (404 otherwise), so the id from the URL grants nothing.
 */
export default function LectureAttendanceRegisterPage({ params }: { params: { lectureId: string } }) {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <Suspense fallback={<div className="mt-6 text-sm text-muted">Loading the attendance register...</div>}>
        <LectureAttendanceRegisterPanel lectureId={params.lectureId} />
      </Suspense>
    </div>
  );
}
