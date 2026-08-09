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
    <div className="flex h-full w-[72px] flex-col items-center border-r border-slate-700 py-5">

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
              ? "bg-blue-600 text-white shadow-lg shadow-blue-600/30"
              : "text-slate-400 hover:bg-slate-800 hover:text-white"
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
              ? "bg-blue-600 text-white shadow-lg shadow-blue-600/30"
              : "text-slate-400 hover:bg-slate-800 hover:text-white"
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
              ? "bg-blue-600 text-white shadow-lg shadow-blue-600/30"
              : "text-slate-400 hover:bg-slate-800 hover:text-white"
          }
        `}
      >
        <FolderOpen size={24} />
      </button>

    </div>
  );
}