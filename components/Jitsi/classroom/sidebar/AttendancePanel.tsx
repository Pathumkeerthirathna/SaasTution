"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Users } from "lucide-react";

import type { JitsiParticipant } from "../../types";

type AttendanceRow = {
  studentId: string;
  name: string;
  attendedLectures: number;
  totalLectures: number;
  attendancePercentage: number;
};

type AttendancePanelProps = {
  classId?: string;
  /** Live meeting participants, used to flag who joined this session. */
  participants: JitsiParticipant[];
};

function barTone(percent: number) {
  if (percent >= 75) return "bg-emerald-500";
  if (percent >= 50) return "bg-amber-500";
  return "bg-red-500";
}

function textTone(percent: number) {
  if (percent >= 75) return "text-emerald-700";
  if (percent >= 50) return "text-amber-700";
  return "text-red-600";
}

export default function AttendancePanel({
  classId,
  participants,
}: AttendancePanelProps) {
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!classId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/classes/${classId}/attendance-summary`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: { students?: AttendanceRow[] };
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data?.students) {
        throw new Error(json.error?.message ?? "Failed to load attendance.");
      }
      setRows(json.data.students);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load attendance.");
    } finally {
      setIsLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    void load();
  }, [load]);

  const joinedNames = new Set(participants.map((p) => p.displayName));
  const joinedCount = rows.filter((r) => joinedNames.has(r.name)).length;
  const avgPercent =
    rows.length === 0
      ? 0
      : Math.round(
          rows.reduce((sum, r) => sum + r.attendancePercentage, 0) / rows.length
        );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-slate-900">
      {/* Summary */}
      <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
              <Users size={14} />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Class attendance
              </h3>
              <p className="text-[11px] text-slate-500">
                {rows.length} student{rows.length === 1 ? "" : "s"} ·{" "}
                {joinedCount} in this session
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className={`text-lg font-bold leading-none ${textTone(avgPercent)}`}>
              {avgPercent}%
            </p>
            <p className="text-[10px] text-slate-400">class average</p>
          </div>
        </div>
      </div>

      {/* Roster */}
      <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" />
            Loading attendance…
          </div>
        ) : error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-center text-xs text-slate-400">
            No students in this class.
          </div>
        ) : (
          rows.map((row) => {
            const inSession = joinedNames.has(row.name);
            return (
              <div
                key={row.studentId}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                    {row.name}
                  </span>
                  {inSession ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                      <CheckCircle2 size={10} />
                      In session
                    </span>
                  ) : null}
                  <span
                    className={`shrink-0 text-sm font-bold tabular-nums ${textTone(
                      row.attendancePercentage
                    )}`}
                  >
                    {row.attendancePercentage}%
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${barTone(
                        row.attendancePercentage
                      )}`}
                      style={{ width: `${row.attendancePercentage}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-400">
                    {row.attendedLectures}/{row.totalLectures} lectures
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
