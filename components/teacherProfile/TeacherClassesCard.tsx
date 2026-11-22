"use client";

import { TeacherClass } from "@/types/teacherProfileTypes/ClassTeacher";
import { UpcomingClassBadge } from "@/components/class-card-visuals";
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
  /*
   * Optional (the signed-in student's Enrolled / Available sections on the
   * teacher profile). Without them the card is exactly the default one.
   */
  heading?: string;
  description?: string;
  countLabel?: string;
  emptyText?: string;
  /** Where a class card leads (default: the public class page, or the dashboard page for the owner). */
  classHref?: (classId: string) => string;
  /** "enrolled" marks the card as the student's own classes (green accent). */
  accent?: "default" | "enrolled";
  hideSummary?: boolean;
}

export default function TeacherClassesCard({
  classes,
  isPublic,
  heading = "Active Classes",
  description = "Classes currently conducted by the teacher.",
  countLabel = "Active Classes",
  emptyText = "No active classes available.",
  classHref,
  accent = "default",
  hideSummary = false,
}: Props) {
  const router = useRouter();
  const hrefFor = (classId: string) =>
    classHref ? classHref(classId) : isPublic ? `/publicClass/${classId}` : `/dashboard/publicclasses/${classId}`;
  const enrolled = accent === "enrolled";

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-white shadow-sm ${enrolled ? "border-emerald-300 ring-1 ring-emerald-100" : "border-slate-200"}`}
      data-classes-section={enrolled ? "enrolled" : "default"}
    >
      {/* Header */}
      <div className={`flex flex-col gap-2 border-b px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between ${enrolled ? "border-emerald-100 bg-emerald-50/60" : "border-slate-100"}`}>
        <div>
          <h3 className="text-[16px] font-bold text-slate-900">
            {heading}
          </h3>

          <p className="mt-0.5 text-[14px] text-slate-500">
            {description}
          </p>
        </div>

        {!isPublic ? (
          <button
            onClick={() => router.push("/dashboard/classes")}
            className="inline-flex h-7 items-center rounded-md bg-[#4D6C90] px-2.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-[#3B5776] hover:shadow-md"
          >
            Manage Classes
          </button>
        ) : (
          <div className="rounded-lg bg-emerald-50 px-3 py-1.5">
            <span className="text-[14px] font-semibold text-emerald-700">
              {classes.length} {countLabel}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      {classes.length === 0 ? (
        <div className="m-5 rounded-lg border border-dashed border-slate-300 py-10 text-center text-[16px] text-slate-500">
          {emptyText}
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
                onClick={() => router.push(hrefFor(item.id))}
                className="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-transparent transition-all duration-300 hover:-translate-y-1 hover:border-teal-200 hover:shadow-xl hover:ring-teal-100"
              >
                {/* Header */}
                <div className={`relative overflow-hidden bg-gradient-to-br ${theme.gradient} py-3 pl-4 pr-4 text-white sm:pr-36`}>
                  <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full ${theme.glow1} blur-2xl`} />
                  <div className={`pointer-events-none absolute -bottom-12 left-10 h-28 w-28 rounded-full ${theme.glow2} blur-2xl`} />

                  {/* Decorative book graphic — dropped on small screens so the class
                      name below always has the full card width to itself. */}
                  <div className="hidden sm:block">
                    <ClassBookBadge
                      label={bookLabel}
                      number={bookNumber}
                      bookGradient={theme.bookGradient}
                      numberColor={theme.numberColor}
                    />
                  </div>

                  <div className="relative flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 shadow-inner backdrop-blur">
                      <ClassIcon className={`h-4 w-4 ${theme.iconColor}`} />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="break-words text-[16px] font-bold leading-tight tracking-tight text-white sm:truncate">
                          {item.name}
                        </h3>

                      </div>

                      <div className={`mt-1 flex items-center gap-1 text-[13px] font-medium ${theme.metaText}`}>
                        <Layers3 size={10} />
                        General
                      </div>
                    </div>
                  </div>

                  <div className="relative mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2">
                    <span className={`break-words text-[12px] sm:truncate ${theme.metaText}`}>
                      {item.schedule || "Schedule not set"}
                    </span>

                    {/* The dashboard's amber badge; only a real future Batch Start Date (never 1900-01-01). */}
                    <UpcomingClassBadge startDate={item.startDate} />
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
                          <p className="break-words text-[16px] font-bold text-slate-900 sm:truncate">
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
                        router.push(hrefFor(item.id));
                      }}
                      className="flex w-full items-center justify-center gap-1 rounded-md bg-[#4D6C90] py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-[#3B5776] hover:shadow-md"
                    >
                      <Eye size={12} />
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
      {hideSummary ? null : <div className="px-5 pb-5">
        <div className="rounded-xl border border-orange-100 bg-gradient-to-r from-orange-50 to-emerald-50 p-4">
          <p className="text-[14px] leading-5 text-slate-700">
            These classes will be visible on the public teacher profile, allowing students and parents to discover and enroll in available programs.
          </p>
        </div>
      </div>}
    </div>
  );
}
