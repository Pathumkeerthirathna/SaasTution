"use client";

import {
  Users,
  ClipboardCheck,
  MessageSquare,
  FileText,
  ClipboardList,
  ListChecks,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type SidebarNavProps = {
  activePanel: string | null;
  onPanelChange: (panel: string) => void;
  /** Show the lecture-bound Notes / Assignments / Quizzes tools (a lecture is on the session). */
  showLectureTools?: boolean;
  /** Show the Attendance tool (teacher only). */
  showAttendance?: boolean;
  /** Unread chat message count shown as a badge on the Chat button. */
  chatUnread?: number;
  /** Rail color scheme: navy/blue for the teacher, green for the student. */
  variant?: "teacher" | "student";
};

const VARIANTS = {
  teacher: {
    border: "border-[#1E293B]",
    divider: "bg-[#1E293B]",
    active: "bg-[#172554] text-[#60A5FA] shadow-lg shadow-[#172554]/40",
    idle: "text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#E2E8F0]",
  },
  student: {
    border: "border-[#1C332B]",
    divider: "bg-[#1C332B]",
    active: "bg-[#22392F] text-white shadow-lg shadow-[#22392F]/40",
    idle: "text-white/90 hover:bg-[#22392F] hover:text-white",
  },
} as const;

export default function SidebarNav({
  activePanel,
  onPanelChange,
  showLectureTools = false,
  showAttendance = false,
  chatUnread = 0,
  variant = "teacher",
}: SidebarNavProps) {
  const theme = VARIANTS[variant];

  const RailButton = ({
    panel,
    label,
    icon: Icon,
    badge,
  }: {
    panel: string;
    label: string;
    icon: LucideIcon;
    badge?: number;
  }) => (
    <button
      type="button"
      onClick={() => onPanelChange(panel)}
      title={label}
      className={`
        relative
        mb-3
        flex h-12 w-12
        items-center justify-center
        rounded-xl
        transition-all duration-200
        ${activePanel === panel ? theme.active : theme.idle}
      `}
    >
      <Icon size={24} />
      {badge ? (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div
      className={`flex h-full w-[72px] flex-col items-center overflow-y-auto scrollbar-none border-r py-5 ${theme.border}`}
    >
      <RailButton panel="participants" label="Participants" icon={Users} />
      {showAttendance ? (
        <RailButton panel="attendance" label="Attendance" icon={ClipboardCheck} />
      ) : null}
      <RailButton
        panel="chat"
        label="Chat"
        icon={MessageSquare}
        badge={chatUnread}
      />

      {showLectureTools ? (
        <>
          <div className={`my-1 h-px w-8 ${theme.divider}`} />
          <RailButton panel="notes" label="Notes" icon={FileText} />
          <RailButton panel="assignments" label="Assignments" icon={ClipboardList} />
          <RailButton panel="quiz" label="Quizzes" icon={ListChecks} />
        </>
      ) : null}
    </div>
  );
}
