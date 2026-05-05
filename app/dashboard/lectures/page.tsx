import dynamic from "next/dynamic";

const LectureManagementPanel = dynamic(() => import("@/components/lecture-management-panel").then((mod) => mod.LectureManagementPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading lecture management...</div>,
});

export default function TeacherLecturesPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col pb-2">
      <LectureManagementPanel />
    </div>
  );
}
