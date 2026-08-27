"use client";

import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";
import {
  CalendarDays,
  Clock,
  Eye,
  FileText,
  Layers3,
  Wallet,
} from "lucide-react";

import { useRouter } from "next/navigation";
import {
  ClassBookBadge,
  formatTime12h,
  getClassBookLabel,
  getClassCardIcon,
  getClassCardTheme,
  getClassNumber,
} from "@/components/class-management-panel";

interface Props {
  isPublic?: boolean;
  classes: TeacherClass[];
}

export default function TeacherClassesCard({
  classes,
  isPublic,
}: Props) {
  const router = useRouter();

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div>
          <h3 className="text-[16px] font-bold text-slate-900">
            Active Classes
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            Classes currently conducted by the teacher.
          </p>
        </div>

        {!isPublic ? (
          <button
            onClick={() => router.push("/dashboard/classes")}
            className="inline-flex h-8 items-center rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-700 px-3 text-[14px] font-semibold text-white shadow-sm transition hover:shadow-md hover:from-emerald-700 hover:to-emerald-800"
          >
            Manage Classes
          </button>
        ) : (
          <div className="rounded-lg bg-emerald-50 px-3 py-1.5">
            <span className="text-[14px] font-semibold text-emerald-700">
              {classes.length} Active Classes
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      {classes.length === 0 ? (
        <div className="m-5 rounded-lg border border-dashed border-slate-300 py-10 text-center text-[16px] text-slate-500">
          No active classes available.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
          {classes.map((item) => {
            const theme = getClassCardTheme(item.id);
            const ClassIcon = getClassCardIcon(item.id);
            const bookLabel = getClassBookLabel(item.name);
            const bookNumber = getClassNumber(item.name);

            return (
              <div
                key={item.id}
                onClick={() =>
                  router.push(
                    isPublic
                      ? `/publicClass/${item.id}`
                      : `/dashboard/publicclasses/${item.id}`
                  )
                }
                className="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-transparent transition-all duration-300 hover:-translate-y-1 hover:border-teal-200 hover:shadow-xl hover:ring-teal-100"
              >
                {/* Header */}
                <div className={`relative overflow-hidden bg-gradient-to-br ${theme.gradient} py-3 pl-4 pr-36 text-white`}>
                  <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full ${theme.glow1} blur-2xl`} />
                  <div className={`pointer-events-none absolute -bottom-12 left-10 h-28 w-28 rounded-full ${theme.glow2} blur-2xl`} />

                  <ClassBookBadge
                    label={bookLabel}
                    number={bookNumber}
                    bookGradient={theme.bookGradient}
                    numberColor={theme.numberColor}
                  />

                  <div className="relative flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 shadow-inner backdrop-blur">
                      <ClassIcon className={`h-4 w-4 ${theme.iconColor}`} />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="truncate text-[16px] font-bold leading-tight tracking-tight text-white">
                          {item.name}
                        </h3>

                      </div>

                      <div className={`mt-1 flex items-center gap-1 text-[13px] font-medium ${theme.metaText}`}>
                        <Layers3 size={10} />
                        General
                      </div>
                    </div>
                  </div>

                  <div className="relative mt-2 flex items-center justify-between border-t border-white/10 pt-2">
                    <span className={`truncate text-[12px] ${theme.metaText}`}>
                      {item.schedule || "Schedule not set"}
                    </span>

                    {item.startDate && new Date(item.startDate).getTime() > Date.now() && (
                      <div className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[12px] font-semibold ${theme.badgeText} backdrop-blur`}>
                        <CalendarDays size={11} />
                        Upcoming: {new Date(item.startDate).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Body */}
                <div className="space-y-3 p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {/* Left: Details */}
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-teal-200">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-teal-100 text-teal-700">
                          <Wallet size={13} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                            Fee
                          </p>
                          <p className="truncate text-[16px] font-bold text-slate-900">
                            Rs. {item.monthlyFee.toLocaleString()}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Right: Schedule */}
                    <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                      <div className="mb-2 flex items-center gap-1.5">
                        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-blue-900/10">
                          <CalendarDays className="h-3 w-3 text-blue-900" />
                        </div>

                        <span className="text-[14px] font-semibold text-slate-800">
                          Weekly Schedule
                        </span>
                      </div>

                      {item.schedules?.length > 0 ? (
                        <div className="space-y-1.5">
                          {item.schedules.slice(0, 2).map((schedule) => (
                            <div
                              key={`${schedule.dayOfWeek}-${schedule.startTime}`}
                              className="flex items-center justify-between rounded-md border border-slate-100 bg-white px-2 py-1.5 shadow-sm"
                            >
                              <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[12px] font-semibold text-blue-700">
                                {schedule.dayOfWeek}
                              </span>

                              <span className="flex items-center gap-1 text-[12px] font-medium text-slate-500">
                                <Clock size={10} className="text-teal-600" />
                                {formatTime12h(schedule.startTime)}
                                {" - "}
                                {formatTime12h(schedule.endTime)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[14px] text-slate-500">
                          Schedule not available
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Description */}
                  <div className="flex items-start gap-1.5">
                    <FileText size={12} className="mt-0.5 shrink-0 text-slate-400" />
                    <p className="line-clamp-2 text-[14px] leading-5 text-slate-600">
                      {item.description || "No class description provided."}
                    </p>
                  </div>

                  {/* Footer */}
                  <div className="border-t border-slate-100 pt-3">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        router.push(
                          isPublic
                            ? `/publicClass/${item.id}`
                            : `/dashboard/publicclasses/${item.id}`
                        );
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-blue-900 to-teal-600 py-2 text-[14px] font-semibold text-white shadow-sm transition hover:shadow-md hover:brightness-110"
                    >
                      <Eye size={13} />
                      View Class
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary */}
      <div className="px-5 pb-5">
        <div className="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-4">
          <p className="text-[14px] leading-5 text-slate-700">
            These classes will be visible on the public teacher profile, allowing students and parents to discover and enroll in available programs.
          </p>
        </div>
      </div>
    </div>
  );
}
