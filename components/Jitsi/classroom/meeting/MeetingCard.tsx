"use client";

import { ReactNode } from "react";
import {
  MonitorPlay,
  Users,
  Wifi,
  ShieldCheck,
  Clock3,
  Radio,
} from "lucide-react";

type MeetingCardProps = {
  children: ReactNode;
  className: string;
  lectureTitle?: string;
  teacherName: string;
  role: "teacher" | "student";
};

export default function MeetingCard({
  children,
  className,
  lectureTitle,
  teacherName,
  role,
}: MeetingCardProps) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0f172a]">

      {/* HEADER */}
      <div className="flex h-[80px] shrink-0 items-center justify-between border-b border-slate-700 bg-[#0F172A] px-5 py-3">

        <div className="flex items-center gap-3">
          <MonitorPlay
            className="text-blue-400"
            size={22}
          />

          <div>
            <h2 className="font-semibold text-white">
              {lectureTitle}
            </h2>

            <p className="text-xs text-slate-400">
              {className}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-5">

          {/* LIVE */}
          <div className="flex items-center gap-2 rounded-full bg-red-500/20 px-3 py-1.5">
            <Radio
              size={16}
              className="animate-pulse text-red-500"
            />

            <span className="font-semibold text-red-400">
              LIVE
            </span>
          </div>

          {/* TIMER */}
          <div className="flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1.5">
            <Clock3
              size={16}
              className="text-slate-300"
            />

            <span className="font-medium text-white">
              00:00:00
            </span>
          </div>

          {/* USER */}
          <div className="rounded-full border border-slate-600 bg-slate-800 px-4 py-1.5">
            <div className="text-xs text-slate-400">
              {role === "teacher" ? "Teacher" : "Student"}
            </div>

            <div className="font-semibold text-white">
              {teacherName}
            </div>
          </div>

          {/* STATUS */}
          <div className="flex items-center gap-2 text-slate-300">
            <Users size={16} />
            <span className="text-sm">
              Connected
            </span>
          </div>

          <div className="flex items-center gap-2 text-green-400">
            <Wifi size={16} />
            <span className="text-sm">
              Excellent
            </span>
          </div>

          <div className="flex items-center gap-2 text-blue-400">
            <ShieldCheck size={16} />
            <span className="text-sm">
              Secure
            </span>
          </div>

        </div>

      </div>

      {/* JITSI CONTENT */}
      <div className="min-h-0 flex-1 overflow-hidden bg-black">
        {children}
      </div>

    </section>
  );
}