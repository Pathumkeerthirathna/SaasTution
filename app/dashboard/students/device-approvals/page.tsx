import dynamic from "next/dynamic";

const StudentDeviceApprovalsPanel = dynamic(
  () =>
    import("@/components/student-device-approvals-panel").then(
      (mod) => mod.StudentDeviceApprovalsPanel
    ),
  {
    loading: () => (
      <div className="mt-6 text-sm text-muted">Loading device approvals...</div>
    ),
  }
);

export default function StudentDeviceApprovalsPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <StudentDeviceApprovalsPanel />
    </div>
  );
}
