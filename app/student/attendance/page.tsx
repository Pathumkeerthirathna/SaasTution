"use client";

import { useEffect, useState } from "react";

import { Panel } from "@/components/student-portal/student-ui";
import type { PaginationMeta } from "@/lib/api-types";

type ClassOption = { id: string; name: string };

type AttendanceRecord = {
  id: string;
  classId: string;
  className: string;
  lectureTitle: string | null;
  joinedAt: string;
  leftAt: string | null;
};

function formatDuration(joinedAt: string, leftAt: string | null): string {
  if (!leftAt) return "—";
  const ms = new Date(leftAt).getTime() - new Date(joinedAt).getTime();
  if (ms <= 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const PAGE_SIZE = 10;

export default function StudentAttendancePage() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  // Reset to page 1 when filters change
  function applyFilter(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(1);
    };
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (classId) params.set("classId", classId);
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));

        const res = await fetch(`/api/students/me/attendance?${params.toString()}`);
        const json = await res.json() as {
          success: boolean;
          data?: { records: AttendanceRecord[]; classes: ClassOption[] };
          pagination?: PaginationMeta;
          error?: { message: string };
        };

        if (!cancelled) {
          if (json.success && json.data) {
            setRecords(json.data.records);
            setClasses(json.data.classes);
            setPagination(json.pagination ?? null);
          } else {
            setError(json.error?.message ?? "Failed to load attendance.");
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load attendance.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [classId, from, to, page]);

  function clearFilters() {
    setClassId("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  const hasFilter = classId || from || to;

  return (
    <Panel title="Attendance / History" subtitle="Review your attended sessions and status.">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border-b border-brand-200 pb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Class</label>
          <select
            value={classId}
            onChange={applyFilter(setClassId)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">From</label>
          <input
            type="date"
            value={from}
            onChange={applyFilter(setFrom)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">To</label>
          <input
            type="date"
            value={to}
            onChange={applyFilter(setTo)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        {hasFilter ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="mt-4">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : records.length === 0 ? (
          <p className="text-sm text-slate-500">No attendance records found{hasFilter ? " for the selected filters" : ""}.</p>
        ) : (
          <div className="space-y-3">
            {records.map((item) => (
              <article key={item.id} className="rounded-xl border border-brand-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-slate-900">{item.className}</p>
                    {item.lectureTitle ? (
                      <p className="text-xs text-slate-500">{item.lectureTitle}</p>
                    ) : null}
                    <p className="mt-1 text-sm text-slate-600">
                      {new Date(item.joinedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      Attended
                    </span>
                    <p className="mt-1 text-xs text-slate-500">
                      Duration: {formatDuration(item.joinedAt, item.leftAt)}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex items-center justify-between border-t border-brand-200 pt-4">
          <p className="text-xs text-slate-500">
            Page {pagination.page} of {pagination.totalPages} &mdash; {pagination.totalItems} record{pagination.totalItems !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!pagination.hasPreviousPage || isLoading}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!pagination.hasNextPage || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
