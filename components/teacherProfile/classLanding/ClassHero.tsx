"use client";

import {
  CalendarDays,
  Clock3,
  GraduationCap,
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

  if(!classInfo){
    alert("NULL");
    return;
  }

  const nextClass = getNextClassDate(
    classInfo.schedules[0].dayOfWeek,
    classInfo.schedules[0].startTime
  );

  return (
    <div className="overflow-hidden rounded-3xl border border-emerald-100 bg-white shadow-sm">

      <div className="p-6">

      <div className="flex items-start justify-between">

          <div className="flex items-center gap-4">

              {/* Class Icon */}

              <div className="
                  flex
                  h-16
                  w-16
                  shrink-0
                  items-center
                  justify-center
                  rounded-2xl
                  bg-gradient-to-br
                  from-emerald-500
                  to-emerald-600
                  shadow-md
              ">

                  <GraduationCap className="h-8 w-8 text-white" />

              </div>

              {/* Class Details */}

              <div>

                  <h1 className="text-3xl font-bold tracking-tight text-slate-900">
                      {classInfo.name}
                  </h1>

                  <p className="mt-1 text-sm text-slate-500">
                      Live Interactive {classInfo.name} Programme
                  </p>

              </div>

          </div>

          <span className="
              rounded-full
              bg-emerald-100
              px-3
              py-1
              text-xs
              font-semibold
              text-emerald-700
          ">
              {/* {classInfo.medium} */}
          </span>

      </div>

        {/* Summary */}

        

        {/* Schedule */}

        {/* Course Information */}

        <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-3">

          {/* Next Class */}

          <div className="flex items-center gap-3">

            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50">
              <CalendarDays className="h-5 w-5 text-emerald-600" />
            </div>

            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Next Class
              </p>

              <p className="text-sm font-semibold text-slate-900">
                 {nextClass}
              </p>
            </div>

          </div>

          {/* Schedule */}

          <div className="flex items-center gap-3 border-l border-slate-200 pl-4">

            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50">
              <Clock3 className="h-5 w-5 text-orange-500" />
            </div>

            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Schedule
              </p>

              <p className="text-sm font-semibold text-slate-900">
                {classInfo.schedule}
              </p>
            </div>

          </div>

          {/* Fee */}

          <div className="flex items-center justify-between rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">

            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-orange-700">
                Monthly Fee
              </p>

              <p className="mt-1 text-2xl font-bold text-orange-600">
                Rs. {classInfo.monthlyFee.toLocaleString()}
              </p>
            </div>

            <div className="rounded-xl bg-orange-100 px-3 py-2">
              <span className="text-xs font-semibold text-orange-700">
                / Month
              </span>
            </div>

          </div>

        </div>

                {/* Buttons */}

                

              </div>

            </div>
          );
        }