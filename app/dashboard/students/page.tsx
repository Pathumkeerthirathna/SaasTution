import dynamic from "next/dynamic";

const StudentGuardianManagementPanel = dynamic(
  () => import("@/components/student-guardian-management-panel").then((mod) => mod.StudentGuardianManagementPanel),
  {
    loading: () => <div className="mt-6 text-sm text-muted">Loading student management...</div>,
  }
);

export default function StudentManagementPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col pb-2">
      <StudentGuardianManagementPanel />
    </div>
  );
}
