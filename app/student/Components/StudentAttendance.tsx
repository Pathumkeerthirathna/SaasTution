"use client";

import Link from "next/link";
import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  LogIn,
  LogOut,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface ClassAttendance {
  classId: string;
  className: string;
  attendedLectures: number;
  totalLectures: number;
  attendancePercentage: number;
}

interface LectureAttendance {
  lectureId: string;
  title: string;
  date: string;
  attended: boolean;
  joinedAt?: string | null;
  leftAt?: string | null;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
}

interface StudentAttendanceProps {
  studentId: string;
  /** When provided by the parent page, the tab renders this instead of fetching. */
  data?: ClassAttendance[] | null;
}

function fmtDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtTime(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(joinedAt?: string | null, leftAt?: string | null) {
  if (!joinedAt || !leftAt) return null;
  const ms = new Date(leftAt).getTime() - new Date(joinedAt).getTime();
  if (ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function StudentAttendance({ studentId, data }: StudentAttendanceProps) {
  const controlled = data !== undefined;

  const [fetched, setFetched] = useState<ClassAttendance[] | null>(null);
  const [lecturesByClass, setLecturesByClass] = useState<
    Record<string, LectureAttendance[]>
  >({});
  const [lecturesLoading, setLecturesLoading] = useState(true);

  const loadAttendance = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/attendance`
      );
      const result: ApiResponse<ClassAttendance[]> = await response.json();
      setFetched(result.success && result.data ? result.data : []);
    } catch {
      setFetched([]);
    }
  }, [studentId]);

  useEffect(() => {
    if (controlled) return;
    void loadAttendance();
  }, [controlled, loadAttendance]);

  const classes = (controlled ? data : fetched) ?? [];
  const summaryLoading = (controlled ? data : fetched) == null;

  // Auto-load per-class lecture detail — no "View details" click required.
  useEffect(() => {
    if (summaryLoading || classes.length === 0) {
      if (classes.length === 0) setLecturesLoading(false);
      return;
    }

    let cancelled = false;
    setLecturesLoading(true);

    Promise.all(
      classes.map(async (cls) => {
        try {
          const response = await fetch(
            `/api/student/Profile/${studentId}/attendance/${cls.classId}`
          );
          const result: ApiResponse<LectureAttendance[]> =
            await response.json();
          return [cls.classId, result.success && result.data ? result.data : []] as const;
        } catch {
          return [cls.classId, [] as LectureAttendance[]] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setLecturesByClass(Object.fromEntries(entries));
      setLecturesLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, summaryLoading, classes.map((c) => c.classId).join(",")]);

  if (summaryLoading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="animate-pulse rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div className="h-3.5 w-40 rounded bg-slate-200" />
              <div className="h-4 w-10 rounded bg-slate-100" />
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-slate-100" />
            <div className="mt-3 space-y-2">
              {[0, 1].map((x) => (
                <div key={x} className="h-8 rounded-md bg-slate-50" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <CalendarDays className="mx-auto mb-2 h-8 w-8 text-slate-400" />
        <h3 className="text-[13px] font-semibold text-slate-900">
          No attendance records
        </h3>
        <p className="mt-1 text-[12px] text-slate-500">
          Attendance appears once this student joins lecture sessions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {classes.map((cls) => {
        const good = cls.attendancePercentage >= 75;
        const lectures = lecturesByClass[cls.classId] ?? [];
        const rowsLoading = lecturesLoading && !lecturesByClass[cls.classId];

        return (
          <div
            key={cls.classId}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            {/* Header */}
            <div className="border-b border-slate-100 px-3.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-slate-900">
                    <BookOpen size={14} className="shrink-0 text-teal-600" />
                    {cls.className}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {cls.attendedLectures} of {cls.totalLectures} lectures
                    attended
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p
                    className={`text-base font-bold leading-none ${
                      good ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {cls.attendancePercentage}%
                  </p>
                  <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                    Attendance
                  </p>
                </div>
              </div>

              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${
                    good ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(100, cls.attendancePercentage)
                    )}%`,
                  }}
                />
              </div>
            </div>

            {/* Lecture rows */}
            {rowsLoading ? (
              <div className="space-y-1.5 p-2.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-10 animate-pulse rounded-md bg-slate-50"
                  />
                ))}
              </div>
            ) : lectures.length === 0 ? (
              <p className="px-3.5 py-3 text-[11px] text-slate-400">
                No lectures scheduled for this class yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-50">
                {lectures.map((lecture) => {
                  const joined = fmtTime(lecture.joinedAt);
                  const left = fmtTime(lecture.leftAt);
                  const duration = fmtDuration(
                    lecture.joinedAt,
                    lecture.leftAt
                  );

                  return (
                    <li key={lecture.lectureId}>
                      <Link
                        href={`/dashboard/lectures?focusLectureId=${lecture.lectureId}`}
                        className="flex items-center gap-3 px-3.5 py-2 transition-colors hover:bg-slate-50"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] font-medium text-slate-800">
                            {lecture.title}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                            <span className="inline-flex items-center gap-1">
                              <CalendarDays size={10} />
                              {fmtDate(lecture.date)}
                            </span>
                            {lecture.attended && joined && (
                              <span className="inline-flex items-center gap-1">
                                <LogIn size={10} className="text-emerald-500" />
                                {joined}
                              </span>
                            )}
                            {lecture.attended && left && (
                              <span className="inline-flex items-center gap-1">
                                <LogOut size={10} className="text-slate-400" />
                                {left}
                              </span>
                            )}
                            {lecture.attended && duration && (
                              <span className="inline-flex items-center gap-1">
                                <Timer size={10} className="text-teal-500" />
                                {duration}
                              </span>
                            )}
                          </p>
                        </div>

                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                            lecture.attended
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-rose-100 text-rose-700"
                          }`}
                        >
                          {lecture.attended ? "Present" : "Absent"}
                        </span>

                        <ChevronRight
                          size={13}
                          className="shrink-0 text-slate-300"
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
