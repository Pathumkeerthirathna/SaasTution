"use client";

import {
  CalendarDays,
  Clock3,
  GraduationCap,
  Wallet,
} from "lucide-react";
import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";

interface Props {
  classInfo: TeacherClass;
}

function getNextClassDate(
  dayOfWeek: string,
  startTime: string
) {
  const days = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };

  const now = new Date();

  const target = new Date(now);

  const targetDay = days[dayOfWeek as keyof typeof days];

  let diff = targetDay - now.getDay();

  if (diff < 0) diff += 7;

  target.setDate(now.getDate() + diff);

  const [hour, minute] = startTime.split(":");

  target.setHours(Number(hour));
  target.setMinutes(Number(minute));
  target.setSeconds(0);

  if (target < now) {
    target.setDate(target.getDate() + 7);
  }

  return target.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export default function ClassHero({
  classInfo,
}: Props) {

  if (!classInfo) {
    return null;
  }

  const nextClass = getNextClassDate(
    classInfo.schedules[0].dayOfWeek,
    classInfo.schedules[0].startTime
  );

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">

        <div className="flex items-center gap-3">

          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 text-white">
            <GraduationCap className="h-4 w-4" />
          </div>

          <div>
            <h1 className="text-[16px] font-bold tracking-tight text-slate-900">
              {classInfo.name}
            </h1>

            <p className="mt-0.5 text-[14px] text-slate-500">
              Live interactive {classInfo.name} programme
            </p>
          </div>

        </div>

      </div>

      {/* Course info */}
      <div className="p-5">

        <div className="grid gap-3 sm:grid-cols-3">

          {/* Next Class */}
          <div className="flex items-center gap-2.5 rounded-lg border border-slate-100 bg-slate-50/70 p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100">
              <CalendarDays className="h-4 w-4 text-emerald-600" />
            </div>

            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">
                Next Class
              </p>
              <p className="truncate text-[15px] font-semibold text-slate-900">
                {nextClass}
              </p>
            </div>
          </div>

          {/* Schedule */}
          <div className="flex items-center gap-2.5 rounded-lg border border-slate-100 bg-slate-50/70 p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <Clock3 className="h-4 w-4 text-orange-500" />
            </div>

            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">
                Schedule
              </p>
              <p className="truncate text-[15px] font-semibold text-slate-900">
                {classInfo.schedule}
              </p>
            </div>
          </div>

          {/* Fee */}
          <div className="flex items-center gap-2.5 rounded-lg border border-orange-200 bg-orange-50 p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <Wallet className="h-4 w-4 text-orange-600" />
            </div>

            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-orange-700">
                Monthly Fee
              </p>
              <p className="truncate text-[15px] font-bold text-orange-600">
                Rs. {classInfo.monthlyFee.toLocaleString()}
              </p>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
