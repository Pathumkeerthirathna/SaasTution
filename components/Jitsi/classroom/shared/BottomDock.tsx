"use client";

import {
  MessageSquare,
  FileText,
  ClipboardCheck,
  PenTool,
  FolderOpen,
  HelpCircle,
} from "lucide-react";

type BottomDockProps = {
  role: "teacher" | "student";
};

export default function BottomDock({
  role,
}: BottomDockProps) {
  const teacherItems = [
    {
      icon: ClipboardCheck,
      label: "Attendance",
    },
    {
      icon: FolderOpen,
      label: "Resources",
    },
    {
      icon: PenTool,
      label: "Whiteboard",
    },
    {
      icon: MessageSquare,
      label: "Chat",
    },
    {
      icon: HelpCircle,
      label: "Quiz",
    },
    {
      icon: FileText,
      label: "Notes",
    },
  ];

  const studentItems = [
    {
      icon: FolderOpen,
      label: "Resources",
    },
    {
      icon: MessageSquare,
      label: "Chat",
    },
    {
      icon: FileText,
      label: "Notes",
    },
    {
      icon: HelpCircle,
      label: "Quiz",
    },
  ];

  const items =
    role === "teacher"
      ? teacherItems
      : studentItems;

  return (
    <div className="mt-6 rounded-3xl border border-slate-700 bg-[#111827] p-4 shadow-xl">

      <div className="flex flex-wrap justify-center gap-5">

        {items.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.label}
              className="flex min-w-[110px] flex-col items-center rounded-2xl px-5 py-4 transition hover:bg-slate-800"
            >
              <Icon
                size={24}
                className="text-blue-400"
              />

              <span className="mt-2 text-sm font-medium text-slate-300">
                {item.label}
              </span>

            </button>
          );
        })}

      </div>

    </div>
  );
}