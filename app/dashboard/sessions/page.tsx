import dynamic from "next/dynamic";

const TeacherSessionPanel = dynamic(() => import("@/components/teacher-session-panel").then((mod) => mod.TeacherSessionPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading live sessions...</div>,
});

export default function TeacherSessionsPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <TeacherSessionPanel />
    </div>
  );
}
