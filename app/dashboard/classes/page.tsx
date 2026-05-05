import Link from "next/link";
import dynamic from "next/dynamic";

const ClassManagementPanel = dynamic(() => import("@/components/class-management-panel").then((mod) => mod.ClassManagementPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading class management...</div>,
});

export default function TeacherClassesPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col pb-2">
      <ClassManagementPanel />
    </div>
  );
}
