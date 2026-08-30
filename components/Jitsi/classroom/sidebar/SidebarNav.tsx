"use client";

import {
  Users,
  ClipboardCheck,
  FolderOpen,
  FileText,
  ClipboardList,
  ListChecks,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type SidebarNavProps = {
  activePanel: string | null;
  onPanelChange: (panel: string) => void;
  /** Show the lecture-bound Notes / Assignments / Quizzes tools (teacher + a lecture on the session). */
  showLectureTools?: boolean;
};

export default function SidebarNav({
  activePanel,
  onPanelChange,
  showLectureTools = false,
}: SidebarNavProps) {
  const RailButton = ({
    panel,
    label,
    icon: Icon,
  }: {
    panel: string;
    label: string;
    icon: LucideIcon;
  }) => (
    <button
      type="button"
      onClick={() => onPanelChange(panel)}
      title={label}
      className={`
        mb-3
        flex h-12 w-12
        items-center justify-center
        rounded-xl
        transition-all duration-200
        ${
          activePanel === panel
            ? "bg-[#172554] text-[#60A5FA] shadow-lg shadow-[#172554]/40"
            : "text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#E2E8F0]"
        }
      `}
    >
      <Icon size={24} />
    </button>
  );

  return (
    <div className="flex h-full w-[72px] flex-col items-center overflow-y-auto scrollbar-none border-r border-[#1E293B] py-5">
      <RailButton panel="participants" label="Participants" icon={Users} />
      <RailButton panel="attendance" label="Attendance" icon={ClipboardCheck} />
      <RailButton panel="resources" label="Resources" icon={FolderOpen} />

      {showLectureTools ? (
        <>
          <div className="my-1 h-px w-8 bg-[#1E293B]" />
          <RailButton panel="notes" label="Notes" icon={FileText} />
          <RailButton panel="assignments" label="Assignments" icon={ClipboardList} />
          <RailButton panel="quiz" label="Quizzes" icon={ListChecks} />
        </>
      ) : null}
    </div>
  );
}
