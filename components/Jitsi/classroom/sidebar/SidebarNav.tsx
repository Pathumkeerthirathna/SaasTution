"use client";

import {
  Users,
  ClipboardCheck,
  FolderOpen,
} from "lucide-react";

type SidebarNavProps = {
  activePanel: string | null;
  onPanelChange: (panel: string) => void;
};

export default function SidebarNav({
  activePanel,
  onPanelChange,
}: SidebarNavProps) {
  return (
    <div className="flex h-full w-[72px] flex-col items-center border-r border-[#1E293B] py-5">

      {/* Participants */}
      <button
        type="button"
        onClick={() => onPanelChange("participants")}
        title="Participants"
        className={`
          mb-3
          flex h-12 w-12
          items-center justify-center
          rounded-xl
          transition-all duration-200
          ${
            activePanel === "participants"
              ? "bg-[#172554] text-[#60A5FA] shadow-lg shadow-[#172554]/40"
              : "text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#E2E8F0]"
          }
        `}
      >
        <Users size={24} />
      </button>

      {/* Attendance */}
      <button
        type="button"
        onClick={() => onPanelChange("attendance")}
        title="Attendance"
        className={`
          mb-3
          flex h-12 w-12
          items-center justify-center
          rounded-xl
          transition-all duration-200
          ${
            activePanel === "attendance"
              ? "bg-[#172554] text-[#60A5FA] shadow-lg shadow-[#172554]/40"
              : "text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#E2E8F0]"
          }
        `}
      >
        <ClipboardCheck size={24} />
      </button>

      {/* Resources */}
      <button
        type="button"
        onClick={() => onPanelChange("resources")}
        title="Resources"
        className={`
          mb-3
          flex h-12 w-12
          items-center justify-center
          rounded-xl
          transition-all duration-200
          ${
            activePanel === "resources"
              ? "bg-[#172554] text-[#60A5FA] shadow-lg shadow-[#172554]/40"
              : "text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#E2E8F0]"
          }
        `}
      >
        <FolderOpen size={24} />
      </button>

    </div>
  );
}