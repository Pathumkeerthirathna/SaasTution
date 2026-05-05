"use client";

import { useEffect, useState } from "react";

import { AssignmentSubmitButton } from "@/components/student-portal/assignment-submit-button";
import { Panel } from "@/components/student-portal/student-ui";
import type { PaginationMeta } from "@/lib/api-types";

type ClassOption = { id: string; name: string };

type AssignmentRecord = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string;
  classId: string;
  className: string;
  submission: {
    id: string;
    notes: string | null;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    sizeBytes: number;
    submittedAt: string;
  } | null;
};

const PAGE_SIZE = 10;

export default function StudentAssignmentsPage() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [records, setRecords] = useState<AssignmentRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

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

        const res = await fetch(`/api/students/me/assignments?${params.toString()}`);
        const json = await res.json() as {
          success: boolean;
          data?: { records: AssignmentRecord[]; classes: ClassOption[] };
          pagination?: PaginationMeta;
          error?: { message: string };
        };

        if (!cancelled) {
          if (json.success && json.data) {
            setRecords(json.data.records);
            setClasses(json.data.classes);
            setPagination(json.pagination ?? null);
          } else {
            setError(json.error?.message ?? "Failed to load assignments.");
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load assignments.");
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
    <Panel title="Assignments" subtitle="Track and submit your work.">
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
          <label className="text-xs font-medium text-slate-600">Due from</label>
          <input
            type="date"
            value={from}
            onChange={applyFilter(setFrom)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Due to</label>
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
          <div className="rounded-2xl border border-dashed border-brand-200 bg-white/70 p-6 text-sm text-slate-600">
            No assignments found{hasFilter ? " for the selected filters" : " for your classes yet"}.
          </div>
        ) : (
          <div className="space-y-3">
            {records.map((item) => {
              const dueDate = new Date(item.dueDate);
              const sub = item.submission
                ? { ...item.submission, submittedAt: new Date(item.submission.submittedAt) }
                : null;
              return (
                <article key={item.id} className="rounded-xl border border-brand-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-slate-900">{item.title}</h3>
                      <p className="mt-0.5 text-sm text-slate-600">{item.className}</p>
                      <p className="text-sm text-slate-500">
                        Due:{" "}
                        {dueDate.toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                      {item.description ? (
                        <p className="mt-1 line-clamp-2 text-sm text-slate-500">{item.description}</p>
                      ) : null}
                    </div>
                    <div className="shrink-0">
                      <AssignmentSubmitButton
                        assignmentId={item.id}
                        dueDate={dueDate}
                        initialSubmission={sub}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex items-center justify-between border-t border-brand-200 pt-4">
          <p className="text-xs text-slate-500">
            Page {pagination.page} of {pagination.totalPages} &mdash;{" "}
            {pagination.totalItems} assignment{pagination.totalItems !== 1 ? "s" : ""}
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
