import dynamic from "next/dynamic";

const MessageManagementPanel = dynamic(() => import("@/components/message-management-panel").then((mod) => mod.MessageManagementPanel), {
  loading: () => <div className="mt-6 text-sm text-muted">Loading message management...</div>,
});

export default function TeacherMessagesPage() {
  return (
    <div className="flex w-full flex-1 flex-col pb-2">
      <MessageManagementPanel />
    </div>
  );
}
