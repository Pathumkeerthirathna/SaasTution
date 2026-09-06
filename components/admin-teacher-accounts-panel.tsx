"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Mail,
  Package,
  Phone,
  Search,
  Unlock,
  Users,
  XCircle,
} from "lucide-react";
import toast from "react-hot-toast";

type TeacherAccount = {
  id: string;
  name: string;
  email: string;
  contact: string | null;
  createdAt: string;
  isConfirmed: boolean;
  confirmedAt: string | null;
  isRejected: boolean;
  rejectedAt: string | null;
  isBlocked: boolean;
  blockedAt: string | null;
  blockReason: string | null;
  classCount: number;
};

type TeacherClass = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  studentCount: number;
  createdAt: string;
};

type TeacherSubscription = {
  id: string;
  status: string;
  price: number;
  currency: string;
  startDate: string;
  endDate: string | null;
  plan: {
    id: string;
    name: string;
    interval: string;
  };
};

type DateFilter = "ALL" | "MONTH" | "QUARTER" | "YEAR";

const DATE_FILTERS: { value: DateFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "MONTH", label: "This Month" },
  { value: "QUARTER", label: "This Quarter" },
  { value: "YEAR", label: "This Year" },
];

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50] as const;

/** Windowed page numbers with "…" gaps, e.g. [1, "…", 4, 5, 6, "…", 12]. */
function getPageNumbers(current: number, total: number): (number | "...")[] {
  const siblingCount = 1;
  const totalNumbers = siblingCount * 2 + 5;

  if (total <= totalNumbers) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const leftSibling = Math.max(current - siblingCount, 1);
  const rightSibling = Math.min(current + siblingCount, total);

  const showLeftDots = leftSibling > 2;
  const showRightDots = rightSibling < total - 1;

  const pages: (number | "...")[] = [1];

  if (showLeftDots) {
    pages.push("...");
  } else {
    for (let i = 2; i < leftSibling; i++) pages.push(i);
  }

  for (let i = leftSibling; i <= rightSibling; i++) {
    if (i !== 1 && i !== total) pages.push(i);
  }

  if (showRightDots) {
    pages.push("...");
  } else {
    for (let i = rightSibling + 1; i < total; i++) pages.push(i);
  }

  pages.push(total);

  return pages;
}

export function AdminTeacherAccountsPanel() {
  const [teachers, setTeachers] = useState<TeacherAccount[]>([]);
  const [loadingTeachers, setLoadingTeachers] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actingTeacherId, setActingTeacherId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("ALL");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(5);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedTeacherId, setSelectedTeacherId] = useState<string | null>(null);
  const [teacherClasses, setTeacherClasses] = useState<TeacherClass[]>([]);
  const [teacherSubscription, setTeacherSubscription] = useState<TeacherSubscription | null>(null);
  const [loadingClasses, setLoadingClasses] = useState(false);

  const [blockTarget, setBlockTarget] = useState<TeacherAccount | null>(null);
  const [blockReason, setBlockReason] = useState("");

  const [confirmAction, setConfirmAction] = useState<{
    teacher: TeacherAccount;
    path: "confirm" | "reject";
    label: string;
    successMessage: string;
  } | null>(null);

  // Debounce the search box so every keystroke doesn't hit the server.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timeout);
  }, [search]);

  // Any change to search/date filter/page size should jump back to page 1.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, dateFilter, pageSize]);

  async function loadTeachers() {
    setLoadingTeachers(true);
    setErrorMessage(null);

    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        dateFilter,
      });

      if (debouncedSearch) {
        params.set("search", debouncedSearch);
      }

      const response = await fetch(`/api/admin/teacher-accounts?${params.toString()}`);
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Unable to load teachers.");
      }

      setTeachers(payload.data.teachers as TeacherAccount[]);
      setTotalItems(payload.pagination?.totalItems ?? 0);
      setTotalPages(payload.pagination?.totalPages ?? 1);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to load teachers."
      );
    } finally {
      setLoadingTeachers(false);
    }
  }

  useEffect(() => {
    void loadTeachers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, debouncedSearch, dateFilter]);

  // Always default to the first teacher of whatever list just loaded —
  // initial load, a page change, a new search/filter, or after an action.
  useEffect(() => {
    if (teachers.length > 0) {
      void loadTeacherClasses(teachers[0].id);
    } else {
      setSelectedTeacherId(null);
      setTeacherClasses([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachers]);

  const selectedTeacher = useMemo(
    () => teachers.find((teacher) => teacher.id === selectedTeacherId) ?? null,
    [teachers, selectedTeacherId]
  );

  const totalStudents = useMemo(
    () => teacherClasses.reduce((sum, cls) => sum + cls.studentCount, 0),
    [teacherClasses]
  );

  async function loadTeacherClasses(teacherId: string) {
    setSelectedTeacherId(teacherId);
    setTeacherClasses([]);
    setTeacherSubscription(null);
    setLoadingClasses(true);

    try {
      const response = await fetch(`/api/admin/teachers/${teacherId}/classes`);
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Unable to load classes.");
      }

      setTeacherClasses(payload.data.classes as TeacherClass[]);
      setTeacherSubscription(payload.data.subscription as TeacherSubscription | null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to load classes."
      );
    } finally {
      setLoadingClasses(false);
    }
  }

  async function runAction(
    teacherId: string,
    path: "confirm" | "reject" | "unblock",
    successMessage: string
  ) {
    setActingTeacherId(teacherId);

    try {
      const response = await fetch(
        `/api/admin/teacher-accounts/${teacherId}/${path}`,
        { method: "POST" }
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Action failed.");
      }

      toast.success(successMessage);
      await loadTeachers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setActingTeacherId(null);
    }
  }

  async function submitBlock() {
    if (!blockTarget || blockReason.trim().length < 3) return;

    setActingTeacherId(blockTarget.id);

    try {
      const response = await fetch(
        `/api/admin/teacher-accounts/${blockTarget.id}/block`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: blockReason }),
        }
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message ?? "Failed to block teacher.");
      }

      toast.success("Teacher blocked.");
      setBlockTarget(null);
      setBlockReason("");
      await loadTeachers();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to block teacher."
      );
    } finally {
      setActingTeacherId(null);
    }
  }

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      {/* Left — 1/4 width: searchable/filterable teacher list */}
      <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-1">
        <h2 className="text-[14px] font-semibold text-slate-900">
          Registered Teachers
        </h2>
        <p className="mt-0.5 text-[11.5px] text-slate-500">
          Select a teacher to view their classes.
        </p>

        {/* Search */}
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name..."
            className="w-full rounded-lg border border-slate-300 py-1.5 pl-8 pr-2.5 text-[12.5px] outline-none focus:border-brand-500"
          />
        </div>

        {/* Date filters */}
        <div className="mt-2 flex flex-wrap gap-1">
          {DATE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setDateFilter(filter.value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                dateFilter === filter.value
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* List */}
        {loadingTeachers && (
          <p className="mt-4 flex items-center gap-1.5 text-[12px] text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading teachers...
          </p>
        )}

        {errorMessage && (
          <p className="mt-4 rounded-lg bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
            {errorMessage}
          </p>
        )}

        {!loadingTeachers && !errorMessage && teachers.length === 0 && (
          <p className="mt-4 text-[12px] text-slate-500">No teachers found.</p>
        )}

        <div className="mt-3 max-h-[70vh] space-y-2 overflow-y-auto pr-0.5">
          {teachers.map((teacher) => {
            const isSelected = teacher.id === selectedTeacherId;
            const isActing = actingTeacherId === teacher.id;
            const isRejected = teacher.isRejected;
            const isPending = !teacher.isConfirmed && !teacher.isRejected;

            return (
              <div
                key={teacher.id}
                onClick={() => loadTeacherClasses(teacher.id)}
                className={`cursor-pointer rounded-xl border px-3 py-2.5 transition ${
                  isSelected
                    ? "border-brand-600 bg-brand-50"
                    : "border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50"
                }`}
              >
                <p className="text-[12.5px] font-semibold text-slate-900">
                  {teacher.name}
                </p>

                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                  <Mail className="h-3 w-3 shrink-0" />
                  <span className="truncate">{teacher.email}</span>
                </p>

                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                  <Phone className="h-3 w-3 shrink-0" />
                  {teacher.contact || "Not provided"}
                </p>

                <p className="mt-0.5 text-[10.5px] text-slate-400">
                  Registered {formatDate(teacher.createdAt)} · {teacher.classCount} class
                  {teacher.classCount === 1 ? "" : "es"}
                </p>

                {/* Status badges */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {teacher.isConfirmed ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Confirmed{" "}
                      {teacher.confirmedAt && `· ${formatDate(teacher.confirmedAt)}`}
                    </span>
                  ) : isRejected ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                      <XCircle className="h-2.5 w-2.5" />
                      Rejected{" "}
                      {teacher.rejectedAt && `· ${formatDate(teacher.rejectedAt)}`}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                      Pending
                    </span>
                  )}

                  {teacher.isBlocked && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                      <Ban className="h-2.5 w-2.5" />
                      Blocked
                      {teacher.blockedAt && ` · ${formatDate(teacher.blockedAt)}`}
                    </span>
                  )}
                </div>

                {teacher.isBlocked && teacher.blockReason && (
                  <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-slate-500">
                    Reason: {teacher.blockReason}
                  </p>
                )}

                {/* Actions */}
                <div
                  className="mt-2 flex flex-wrap items-center gap-1.5"
                  onClick={(event) => event.stopPropagation()}
                >
                  {isPending && (
                    <>
                      <button
                        type="button"
                        disabled={isActing}
                        onClick={() =>
                          setConfirmAction({
                            teacher,
                            path: "confirm",
                            label: "Confirm",
                            successMessage: "Teacher confirmed.",
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[10.5px] font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Confirm
                      </button>
                      <button
                        type="button"
                        disabled={isActing}
                        onClick={() =>
                          setConfirmAction({
                            teacher,
                            path: "reject",
                            label: "Reject",
                            successMessage: "Teacher rejected.",
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-1 text-[10.5px] font-semibold text-white transition hover:bg-red-600 disabled:opacity-50"
                      >
                        <XCircle className="h-2.5 w-2.5" />
                        Reject
                      </button>
                    </>
                  )}

                  {isRejected && (
                    <button
                      type="button"
                      disabled={isActing}
                      onClick={() =>
                        setConfirmAction({
                          teacher,
                          path: "confirm",
                          label: "Accept",
                          successMessage: "Teacher confirmed.",
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[10.5px] font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Accept
                    </button>
                  )}

                  {teacher.isBlocked ? (
                    <button
                      type="button"
                      disabled={isActing}
                      onClick={() =>
                        runAction(teacher.id, "unblock", "Teacher unblocked.")
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[10.5px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Unlock className="h-2.5 w-2.5" />
                      Unblock
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isActing}
                      onClick={() => {
                        setBlockTarget(teacher);
                        setBlockReason("");
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[10.5px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      <Ban className="h-2.5 w-2.5" />
                      Block
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination */}
        <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={loadingTeachers || page <= 1}
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-600 disabled:opacity-40"
            >
              Previous
            </button>

            <p className="text-[11px] text-slate-500">
              {totalItems} teacher{totalItems === 1 ? "" : "s"}
            </p>

            <button
              type="button"
              disabled={loadingTeachers || page >= totalPages}
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-600 disabled:opacity-40"
            >
              Next
            </button>
          </div>

          {/* Page numbers */}
          <div className="flex flex-wrap items-center justify-center gap-1">
            {getPageNumbers(page, totalPages).map((entry, index) =>
              entry === "..." ? (
                <span
                  key={`ellipsis-${index}`}
                  className="px-1.5 text-[11px] text-slate-400"
                >
                  …
                </span>
              ) : (
                <button
                  key={entry}
                  type="button"
                  disabled={loadingTeachers}
                  onClick={() => setPage(entry)}
                  className={`h-6 min-w-[24px] rounded-md px-1.5 text-[11px] font-medium transition disabled:opacity-40 ${
                    entry === page
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {entry}
                </button>
              )
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-slate-500">Rows per page</label>
            <select
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-brand-500"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        </div>
      </article>

      {/* Right — 3/4 width: classes for the selected teacher */}
      <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">Classes</h2>
            <p className="mt-0.5 text-[11.5px] text-slate-500">
              {selectedTeacher
                ? `Classes for ${selectedTeacher.name}`
                : "Pick a teacher to see their classes."}
            </p>
          </div>

          {selectedTeacher && !loadingClasses && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-[12px] font-semibold text-brand-700">
              <Users className="h-3.5 w-3.5" />
              {totalStudents} registered student{totalStudents === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {!loadingClasses && selectedTeacher && teacherSubscription && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-violet-600" />
              <div>
                <p className="text-[12.5px] font-semibold text-violet-900">
                  {teacherSubscription.plan.name}
                </p>
                <p className="text-[11px] text-violet-600">
                  {teacherSubscription.currency} {teacherSubscription.price.toLocaleString()} /{" "}
                  {teacherSubscription.plan.interval === "MONTHLY" ? "mo" : "yr"}
                </p>
              </div>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[10.5px] font-semibold ${
                teacherSubscription.status === "ACTIVE"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-200 text-slate-600"
              }`}
            >
              {teacherSubscription.status}
            </span>
          </div>
        )}

        {loadingClasses && (
          <p className="mt-4 flex items-center gap-1.5 text-[12px] text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading classes...
          </p>
        )}

        {!loadingClasses && selectedTeacher && teacherClasses.length === 0 && (
          <p className="mt-4 text-[12px] text-slate-500">
            This teacher has no classes yet.
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {teacherClasses.map((classItem) => (
            <div
              key={classItem.id}
              className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
            >
              <p className="text-[12.5px] font-semibold text-slate-900">
                {classItem.name}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                {classItem.description || "No description provided."}
              </p>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Schedule: {classItem.schedule || "Not set"}
              </p>
              <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-[10.5px] font-semibold text-brand-700">
                <Users className="h-2.5 w-2.5" />
                {classItem.studentCount} student{classItem.studentCount === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>
      </article>

      {/* Confirm / Reject confirmation modal */}
      {confirmAction && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  confirmAction.path === "confirm"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                <AlertTriangle size={16} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {confirmAction.label} {confirmAction.teacher.name}?
                </h3>
                <p className="mt-0.5 text-[12px] leading-5 text-slate-500">
                  {confirmAction.path === "confirm"
                    ? "They will be able to sign in and use their dashboard immediately."
                    : "They won't be able to sign in until an officer accepts them later."}
                </p>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                disabled={actingTeacherId === confirmAction.teacher.id}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await runAction(
                    confirmAction.teacher.id,
                    confirmAction.path,
                    confirmAction.successMessage
                  );
                  setConfirmAction(null);
                }}
                disabled={actingTeacherId === confirmAction.teacher.id}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${
                  confirmAction.path === "confirm"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : "bg-red-600 hover:bg-red-700"
                }`}
              >
                {actingTeacherId === confirmAction.teacher.id && (
                  <Loader2 size={13} className="animate-spin" />
                )}
                {actingTeacherId === confirmAction.teacher.id
                  ? "Working..."
                  : `Yes, ${confirmAction.label}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Block reason modal */}
      {blockTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-700">
                <Ban size={16} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Block {blockTarget.name}?
                </h3>
                <p className="mt-0.5 text-[12px] leading-5 text-slate-500">
                  They won&apos;t be able to sign in. The teacher will see the
                  reason you enter below.
                </p>
              </div>
            </div>

            <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              autoFocus
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Repeated policy violations"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-red-400"
            />

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setBlockTarget(null);
                  setBlockReason("");
                }}
                disabled={actingTeacherId === blockTarget.id}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitBlock()}
                disabled={
                  actingTeacherId === blockTarget.id ||
                  blockReason.trim().length < 3
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {actingTeacherId === blockTarget.id && (
                  <Loader2 size={13} className="animate-spin" />
                )}
                {actingTeacherId === blockTarget.id ? "Blocking..." : "Block Teacher"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
