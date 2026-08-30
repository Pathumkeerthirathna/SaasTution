import dynamic from "next/dynamic";
import { Suspense } from "react";

const LectureManagementPanel = dynamic(() => import("@/components/lecture-management-panel").then((mod) => mod.LectureManagementPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading lecture management...</div>,
});

export default function TeacherLecturesPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <Suspense fallback={<div className="mt-6 text-sm text-muted">Loading lecture management...</div>}>
        <LectureManagementPanel />
      </Suspense>
    </div>
  );
}
