"use client";

import { BookOpen, Clock3, Radio } from "lucide-react";

type TopNavbarProps = {
  className: string;
  lectureTitle?: string;
  teacherName: string;
  role: "teacher" | "student";
};

export default function TopNavbar({
  className,
  lectureTitle,
  teacherName,
  role,
}: TopNavbarProps) {
  return (
    <header className="mb-6 overflow-hidden rounded-3xl border border-slate-700 bg-[#111827] shadow-xl">

      <div className="flex items-center justify-between px-8 py-6">

        {/* Left */}

        <div>

          <div className="mb-2 flex items-center gap-2">

            <BookOpen
              className="text-blue-400"
              size={20}
            />

            <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              SaaSTuition Live Classroom
            </span>

          </div>

          <h1 className="text-3xl font-bold text-white">
            {className}
          </h1>

          <p className="mt-1 text-slate-400">
            {lectureTitle || "Live Lecture"}
          </p>

        </div>

        {/* Right */}

        <div className="flex items-center gap-4">

          <div className="flex items-center gap-2 rounded-full bg-red-500/20 px-4 py-2">

            <Radio
              size={16}
              className="animate-pulse text-red-500"
            />

            <span className="font-semibold text-red-400">
              LIVE
            </span>

          </div>

          <div className="flex items-center gap-2 rounded-full bg-slate-800 px-4 py-2">

            <Clock3
              size={16}
              className="text-slate-300"
            />

            <span className="font-medium text-white">
              00:00:00
            </span>

          </div>

          <div className="rounded-full border border-slate-600 bg-slate-800 px-5 py-2">

            <div className="text-xs text-slate-400">
              {role === "teacher"
                ? "Teacher"
                : "Student"}
            </div>

            <div className="font-semibold text-white">
              {teacherName}
            </div>

          </div>

        </div>

      </div>

    </header>
  );
}