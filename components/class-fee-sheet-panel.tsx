"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BadgeCheck,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileText,
  Loader2,
  RefreshCw,
  Users,
  ExternalLink,
  CheckCircle2,
  MessageCircleWarning,
} from "lucide-react";
import toast from "react-hot-toast";

import {
  formatStoredSriLankaDate,
  formatStoredSriLankaDateTime,
} from "@/lib/time";

type ClassOption = {
  id: string;
  name: string;
};

type EnrolmentPeriod = {
  assignedAt: string;
  removedAt: string | null;
};

type ClassFeeHistoryEntry = {
  id: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
};

type FeePaymentDetail = {
  id: string;
  amount: number;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  note: string | null;
  teacherFeedback: string | null;
  hasSlip: boolean;
  submittedAt: string;
  confirmedAt: string | null;
};

type FeeRow = {
  feeId: string | null;
  classStudentId: string;
  studentId: string;
  studentName: string;
  registrationNumber: string | null;
  assignedAt: string;
  enrolments: EnrolmentPeriod[];
  amount: number;
  discount: number;
  lateJoinDeduct: number;
  waiverAmount: number;
  finalAmount: number;
  dueDate: string | null;
  createdAt: string | null;
  hasPaid: boolean;
  paymentStatus: "PAID" | "PENDING" | "UNPAID";
  payments: FeePaymentDetail[];
};

type FeeSheet = {
  class: { id: string; name: string; paymentDueWeek: number };
  year: number;
  month: number;
  currentFee: number;
  periodFee: number;
  isCurrentPeriod: boolean;
  isPastPeriod: boolean;
  isFuturePeriod: boolean;
  processed: boolean;
  dueDate: string;
  isPastDue: boolean;
  isDueSoon: boolean;
  rows: FeeRow[];
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const YEARS_BACK = 40;

function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as { error?: { message?: string }; message?: string };
  return typed.error?.message ?? typed.message ?? fallback;
}

function rupees(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

export function ClassFeeSheetPanel() {
  const now = useMemo(() => new Date(), []);

  const [classes, setClasses] = useState<ClassOption[]>([]);
  // "" means "All classes".
  const [classId, setClassId] = useState("");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [classesLoading, setClassesLoading] = useState(true);

  // Each mounted ClassFeeSheetDetail reports its own expected total here, so
  // the header can show a combined sum across every class currently shown.
  const [expectedTotals, setExpectedTotals] = useState<Record<string, number>>({});
  const handleExpectedTotalChange = useCallback((id: string, expected: number) => {
    setExpectedTotals((prev) =>
      prev[id] === expected ? prev : { ...prev, [id]: expected }
    );
  }, []);
  const relevantClassIds = classId ? [classId] : classes.map((c) => c.id);
  const combinedExpectedTotal = relevantClassIds.reduce(
    (sum, id) => sum + (expectedTotals[id] ?? 0),
    0
  );

  // The month grid has a fixed 4×3 layout; the class and year lists scroll
  // within that same height.
  const monthGridRef = useRef<HTMLDivElement>(null);
  const [selectorMaxHeight, setSelectorMaxHeight] = useState<number>();

  useEffect(() => {
    const element = monthGridRef.current;
    if (!element) return;

    const update = () => setSelectorMaxHeight(element.offsetHeight);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const yearOptions = useMemo(() => {
    const start = now.getFullYear();
    return Array.from({ length: YEARS_BACK }, (_, index) => start - index);
  }, [now]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/classes?page=1&pageSize=50");
        const payload = (await response.json()) as {
          success: boolean;
          data?: ClassOption[];
        };

        if (cancelled) return;

        setClasses(payload.data ?? []);
      } catch {
        if (!cancelled) {
          setClassesError("Failed to load classes.");
        }
      } finally {
        if (!cancelled) setClassesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-4">
      <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#32598A] text-white">
              <CircleDollarSign size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                Monthly Fees
              </h2>
              <p className="text-xs text-slate-500">
                Fee sheet per class, year and month. The current month is
                generated and kept in sync automatically.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-[#dce7f1] bg-[#eef3f8] px-3 py-2 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[#264867]">
              {classId ? "Expected total" : "Expected total · all classes"}
            </p>
            <p className="text-lg font-bold text-[#1a3049]">
              {rupees(combinedExpectedTotal)}
            </p>
          </div>
        </div>

        {/* Selectors — three matching tile pickers */}
        <div className="grid gap-3 lg:grid-cols-3">

          {/* Class */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Class
            </p>
            <div
              className="scrollbar-thin space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5"
              style={{ maxHeight: selectorMaxHeight }}
            >
              <button
                type="button"
                onClick={() => setClassId("")}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                  classId === ""
                    ? "bg-[#32598A] text-white shadow-sm"
                    : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                }`}
              >
                <Users
                  size={12}
                  className={`shrink-0 ${classId === "" ? "text-white" : "text-slate-400"}`}
                />
                <span>All classes</span>
              </button>

              {classesLoading ? (
                <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-400">
                  <Loader2 size={12} className="animate-spin" />
                  Loading classes...
                </p>
              ) : classes.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-slate-400">No classes</p>
              ) : (
                classes.map((item) => {
                  const selected = item.id === classId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setClassId(item.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                        selected
                          ? "bg-[#32598A] text-white shadow-sm"
                          : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                      }`}
                    >
                      <BookOpen
                        size={12}
                        className={`shrink-0 ${selected ? "text-white" : "text-slate-400"}`}
                      />
                      <span className="break-words">{item.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Year */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Year
            </p>
            <div
              className="scrollbar-thin grid grid-cols-3 gap-1.5 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5"
              style={{ maxHeight: selectorMaxHeight }}
            >
              {yearOptions.map((option) => {
                const selected = option === year;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setYear(option)}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      selected
                        ? "bg-[#32598A] text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Month — 4 per row */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Month
            </p>
            <div
              ref={monthGridRef}
              className="grid grid-cols-4 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5"
            >
              {MONTHS.map((label, index) => {
                const value = index + 1;
                const selected = value === month;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setMonth(value)}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      selected
                        ? "bg-[#32598A] text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-[#eef3f8]"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {classesError ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {classesError}
          </p>
        ) : null}

        {classId ? (
          <ClassFeeSheetDetail
            classId={classId}
            year={year}
            month={month}
            onExpectedTotalChange={handleExpectedTotalChange}
          />
        ) : null}
      </article>

      {!classId ? (
        <div className="space-y-4">
          {classesLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#b9cfe3] bg-[#eef3f8]/60 p-8 text-sm font-medium text-[#264867]">
              <Loader2 size={16} className="animate-spin" />
              Loading classes...
            </div>
          ) : classes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              No classes yet.
            </p>
          ) : (
            classes.map((item) => (
              <article
                key={item.id}
                className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <BookOpen size={14} className="text-[#32598A]" />
                    {item.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setClassId(item.id)}
                    className="text-xs font-semibold text-[#264867] hover:underline"
                  >
                    Manage only this class &rarr;
                  </button>
                </div>
                <ClassFeeSheetDetail
                  classId={item.id}
                  year={year}
                  month={month}
                  onExpectedTotalChange={handleExpectedTotalChange}
                />
              </article>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

type ClassFeeSheetDetailProps = {
  classId: string;
  year: number;
  month: number;
  onExpectedTotalChange?: (classId: string, expected: number) => void;
};

function ClassFeeSheetDetail({
  classId,
  year,
  month,
  onExpectedTotalChange,
}: ClassFeeSheetDetailProps) {
  const now = useMemo(() => new Date(), []);

  const [sheet, setSheet] = useState<FeeSheet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savingFeeId, setSavingFeeId] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [feeHistory, setFeeHistory] = useState<ClassFeeHistoryEntry[]>([]);

  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  const isFutureSelection =
    year > nowYear || (year === nowYear && month > nowMonth);
  const willProcess = !isFutureSelection;

  const loadSheet = useCallback(async () => {
    if (!classId) return;

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        classId,
        year: String(year),
        month: String(month),
      });

      const response = await fetch(`/api/payments/fees?${query.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FeeSheet;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to load fee sheet."));
      }

      setSheet(payload.data);
    } catch (error) {
      setSheet(null);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to load fee sheet."
      );
    } finally {
      setIsLoading(false);
    }
  }, [classId, year, month]);

  useEffect(() => {
    void loadSheet();
  }, [loadSheet]);

  // Fee history for the amount picker.
  useEffect(() => {
    if (!classId) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/classes/${classId}/fee-history`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as {
          success: boolean;
          data?: ClassFeeHistoryEntry[];
        };
        if (!cancelled && payload.success) {
          setFeeHistory(payload.data ?? []);
        }
      } catch {
        if (!cancelled) setFeeHistory([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [classId]);

  async function applyAmount(
    row: FeeRow,
    amount: number,
    applyToAll: boolean
  ) {
    setSavingFeeId(row.feeId ?? "all");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/payments/fees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId,
          year,
          month,
          amount,
          applyToAll,
          feeId: row.feeId,
        }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FeeSheet;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to update amount."));
      }

      setSheet(payload.data);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to update amount."
      );
    } finally {
      setSavingFeeId(null);
    }
  }

  async function reprocess() {
    if (!classId || isReprocessing) return;

    setIsReprocessing(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/payments/fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, year, month }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: FeeSheet;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to reprocess fees."));
      }

      setSheet(payload.data);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to reprocess fees."
      );
    } finally {
      setIsReprocessing(false);
    }
  }

  async function saveAdjustment(
    row: FeeRow,
    field: "discount" | "lateJoinDeduct" | "waiverAmount",
    rawValue: string
  ) {
    if (!row.feeId) return;

    const value = Math.max(0, Math.round(Number(rawValue) || 0));

    if (value === row[field]) return;

    setSavingFeeId(row.feeId);

    try {
      const response = await fetch(`/api/payments/fees/${row.feeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          discount: number;
          lateJoinDeduct: number;
          waiverAmount: number;
          finalAmount: number;
        };
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to update adjustment."));
      }

      setSheet((current) => {
        if (!current) return current;
        return {
          ...current,
          rows: current.rows.map((r) =>
            r.feeId === row.feeId ? { ...r, ...payload.data! } : r
          ),
        };
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to update adjustment."
      );
      // Reload to restore the correct values.
      void loadSheet();
    } finally {
      setSavingFeeId(null);
    }
  }

  const totals = useMemo(() => {
    const rows = sheet?.rows ?? [];
    return {
      students: rows.length,
      expected: rows.reduce((sum, row) => sum + row.finalAmount, 0),
      paid: rows.filter((row) => row.paymentStatus === "PAID").length,
    };
  }, [sheet]);

  useEffect(() => {
    onExpectedTotalChange?.(classId, totals.expected);
  }, [classId, totals.expected, onExpectedTotalChange]);

  return (
    <div className="space-y-4">
        {/* Status strip */}
        {sheet ? (
          <div className="grid gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Current class fee
              </p>
              <p className="text-sm font-bold text-slate-900">
                {rupees(sheet.currentFee)}
              </p>
              {sheet.periodFee !== sheet.currentFee ? (
                <p className="text-[10px] text-slate-400">
                  Applied this month: {rupees(sheet.periodFee)}
                </p>
              ) : null}
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Due date (week {sheet.class.paymentDueWeek})
              </p>
              <p className="text-sm font-bold text-slate-900">
                {formatStoredSriLankaDate(sheet.dueDate)}
                {sheet.isPastDue ? (
                  <span className="ml-1 rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-600">
                    Past due
                  </span>
                ) : sheet.isDueSoon ? (
                  <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-600">
                    Due soon
                  </span>
                ) : null}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Students
              </p>
              <p className="text-sm font-bold text-slate-900">
                {totals.students}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Expected total
              </p>
              <p className="text-sm font-bold text-slate-900">
                {rupees(totals.expected)}
              </p>
            </div>
          </div>
        ) : null}

        {errorMessage ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
          </p>
        ) : null}

        {/* Processing / loading */}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#b9cfe3] bg-[#eef3f8]/60 py-8 text-sm font-medium text-[#264867]">
            <Loader2 size={16} className="animate-spin" />
            {willProcess
              ? "Processing fees for this month..."
              : "Loading fee records..."}
          </div>
        ) : null}

        {/* Table */}
        {!isLoading && sheet ? (
          <>
          {!sheet.isFuturePeriod ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {MONTHS[month - 1]} {year} · {sheet.rows.length}{" "}
                {sheet.rows.length === 1 ? "student" : "students"}
              </p>
              <button
                type="button"
                onClick={() => void reprocess()}
                disabled={isReprocessing}
                title="Recompute every fee from the fee applicable at the due date and refresh paid/unpaid status"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#b9cfe3] bg-[#eef3f8] px-3 py-1.5 text-xs font-semibold text-[#264867] transition hover:bg-[#dce7f1] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw
                  size={13}
                  className={isReprocessing ? "animate-spin" : ""}
                />
                {isReprocessing ? "Reprocessing..." : "Reprocess"}
              </button>
            </div>
          ) : null}

          {sheet.rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 py-8 text-center">
              <Users size={22} className="mx-auto text-slate-300" />
              <p className="mt-2 text-sm font-medium text-slate-600">
                No fee records for {MONTHS[month - 1]} {year}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {sheet.isFuturePeriod
                  ? "This month has not started yet."
                  : sheet.isCurrentPeriod
                  ? "No active students in this class."
                  : "No students were enrolled in this class during this month."}
              </p>
            </div>
          ) : (
            <>
              {/*
                Below xl there isn't room for the sidebar (256px) plus this
                table's 860px minimum without horizontal scrolling, so each
                student renders as its own card instead — same data, same
                editable amount/discount/late-deduct/waiver controls and the
                same expand-to-view-payment-history behaviour, just stacked.
              */}
              <div className="space-y-3 xl:hidden">
                {sheet.rows.map((row) => {
                  const paidLocked = row.paymentStatus === "PAID";
                  const locked =
                    !row.feeId ||
                    savingFeeId === row.feeId ||
                    paidLocked;
                  const rowKey = row.feeId ?? row.classStudentId;
                  const isExpanded = expandedRowKey === rowKey;
                  const stop = (event: React.MouseEvent) =>
                    event.stopPropagation();

                  return (
                    <div
                      key={rowKey}
                      className={`overflow-hidden rounded-xl border border-slate-200 ${
                        isExpanded ? "bg-slate-50" : "bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRowKey((current) =>
                            current === rowKey ? null : rowKey
                          )
                        }
                        className="flex w-full items-start justify-between gap-2 p-3 text-left"
                      >
                        <div className="flex min-w-0 items-start gap-1.5">
                          {isExpanded ? (
                            <ChevronDown size={13} className="mt-0.5 shrink-0 text-slate-400" />
                          ) : (
                            <ChevronRight size={13} className="mt-0.5 shrink-0 text-slate-400" />
                          )}
                          <div className="min-w-0">
                            <p className="break-words text-xs font-semibold text-slate-900">
                              {row.studentName}
                            </p>
                            {row.registrationNumber ? (
                              <p className="text-[10px] text-slate-400">
                                {row.registrationNumber}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {row.paymentStatus === "PAID" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <BadgeCheck size={10} />
                              Paid
                            </span>
                          ) : row.paymentStatus === "PENDING" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              <Clock3 size={10} />
                              Pending
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              Unpaid
                            </span>
                          )}
                        </div>
                      </button>

                      <div
                        className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-slate-100 px-3 py-3 text-xs"
                        onClick={stop}
                      >
                        <div className="col-span-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Assigned
                          </p>
                          <div className="mt-0.5 space-y-0.5">
                            {(row.enrolments.length > 0
                              ? row.enrolments
                              : [{ assignedAt: row.assignedAt, removedAt: null }]
                            ).map((period, index) => (
                              <div key={index} className="leading-tight">
                                <span className="text-slate-500">
                                  {formatStoredSriLankaDate(period.assignedAt)}
                                </span>
                                {period.removedAt ? (
                                  <span className="block text-[10px] font-medium text-rose-500">
                                    Removed {formatStoredSriLankaDate(period.removedAt)}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Amount
                          </p>
                          <div className="mt-0.5">
                            <AmountCell
                              row={row}
                              feeHistory={feeHistory}
                              currentFee={sheet.currentFee}
                              studentCount={sheet.rows.length}
                              paid={paidLocked}
                              busy={
                                savingFeeId === row.feeId || savingFeeId === "all"
                              }
                              onApply={(amount, applyToAll) =>
                                void applyAmount(row, amount, applyToAll)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Final
                          </p>
                          <p className="mt-0.5 font-bold text-slate-900">
                            {rupees(row.finalAmount)}
                          </p>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Discount
                          </p>
                          <div className="mt-0.5">
                            <AdjustInput
                              defaultValue={row.discount}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "discount", value)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Late deduct
                          </p>
                          <div className="mt-0.5">
                            <AdjustInput
                              defaultValue={row.lateJoinDeduct}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "lateJoinDeduct", value)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Waiver
                          </p>
                          <div className="mt-0.5">
                            <AdjustInput
                              defaultValue={row.waiverAmount}
                              disabled={locked}
                              onCommit={(value) =>
                                void saveAdjustment(row, "waiverAmount", value)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            Due date
                          </p>
                          <p className="mt-0.5 text-slate-500">
                            {formatStoredSriLankaDate(row.dueDate)}
                          </p>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="border-t border-slate-100 bg-slate-50/70 p-3" onClick={stop}>
                          <PaymentAccordion
                            payments={row.payments}
                            finalAmount={row.finalAmount}
                            classId={sheet.class.id}
                            onChanged={loadSheet}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 xl:block">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Student</th>
                    <th className="px-3 py-2 font-semibold">Assigned</th>
                    <th className="px-3 py-2 font-semibold">Amount</th>
                    <th className="px-3 py-2 font-semibold">Discount</th>
                    <th className="px-3 py-2 font-semibold">Late deduct</th>
                    <th className="px-3 py-2 font-semibold">Waiver</th>
                    <th className="px-3 py-2 font-semibold">Final</th>
                    <th className="px-3 py-2 font-semibold">Due date</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sheet.rows.map((row) => {
                    // A confirmed payment freezes the whole row.
                    const paidLocked = row.paymentStatus === "PAID";
                    const locked =
                      !row.feeId ||
                      savingFeeId === row.feeId ||
                      paidLocked;
                    const rowKey = row.feeId ?? row.classStudentId;
                    const isExpanded = expandedRowKey === rowKey;
                    const stop = (event: React.MouseEvent) =>
                      event.stopPropagation();

                    return (
                      <Fragment key={rowKey}>
                      <tr
                        onClick={() =>
                          setExpandedRowKey((current) =>
                            current === rowKey ? null : rowKey
                          )
                        }
                        className={`cursor-pointer align-middle transition hover:bg-slate-50 ${
                          isExpanded ? "bg-slate-50" : ""
                        }`}
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-start gap-1.5">
                            {isExpanded ? (
                              <ChevronDown size={13} className="mt-0.5 shrink-0 text-slate-400" />
                            ) : (
                              <ChevronRight size={13} className="mt-0.5 shrink-0 text-slate-400" />
                            )}
                            <div>
                              <p className="font-semibold text-slate-900">
                                {row.studentName}
                              </p>
                              {row.registrationNumber ? (
                                <p className="text-[10px] text-slate-400">
                                  {row.registrationNumber}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="space-y-0.5">
                            {(row.enrolments.length > 0
                              ? row.enrolments
                              : [{ assignedAt: row.assignedAt, removedAt: null }]
                            ).map((period, index) => (
                              <div key={index} className="leading-tight">
                                <span className="text-slate-500">
                                  {formatStoredSriLankaDate(period.assignedAt)}
                                </span>
                                {period.removedAt ? (
                                  <span className="block text-[10px] font-medium text-rose-500">
                                    Removed {formatStoredSriLankaDate(period.removedAt)}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AmountCell
                            row={row}
                            feeHistory={feeHistory}
                            currentFee={sheet.currentFee}
                            studentCount={sheet.rows.length}
                            paid={paidLocked}
                            busy={
                              savingFeeId === row.feeId || savingFeeId === "all"
                            }
                            onApply={(amount, applyToAll) =>
                              void applyAmount(row, amount, applyToAll)
                            }
                          />
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AdjustInput
                            defaultValue={row.discount}
                            disabled={locked}
                            onCommit={(value) =>
                              void saveAdjustment(row, "discount", value)
                            }
                          />
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AdjustInput
                            defaultValue={row.lateJoinDeduct}
                            disabled={locked}
                            onCommit={(value) =>
                              void saveAdjustment(row, "lateJoinDeduct", value)
                            }
                          />
                        </td>
                        <td className="px-3 py-2" onClick={stop}>
                          <AdjustInput
                            defaultValue={row.waiverAmount}
                            disabled={locked}
                            onCommit={(value) =>
                              void saveAdjustment(row, "waiverAmount", value)
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-bold text-slate-900">
                          {rupees(row.finalAmount)}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {formatStoredSriLankaDate(row.dueDate)}
                        </td>
                        <td className="px-3 py-2">
                          {row.paymentStatus === "PAID" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <BadgeCheck size={10} />
                              Paid
                            </span>
                          ) : row.paymentStatus === "PENDING" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              <Clock3 size={10} />
                              Pending
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              Unpaid
                            </span>
                          )}
                        </td>
                      </tr>

                      {isExpanded ? (
                        <tr className="bg-slate-50/70">
                          <td colSpan={9} className="px-3 pb-3 pt-1">
                            <PaymentAccordion
                              payments={row.payments}
                              finalAmount={row.finalAmount}
                              classId={sheet.class.id}
                              onChanged={loadSheet}
                            />
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </>
          )}
          </>
        ) : null}

    </div>
  );
}

function AmountCell({
  row,
  feeHistory,
  currentFee,
  studentCount,
  paid,
  busy,
  onApply,
}: {
  row: FeeRow;
  feeHistory: ClassFeeHistoryEntry[];
  currentFee: number;
  studentCount: number;
  paid?: boolean;
  busy?: boolean;
  onApply: (amount: number, applyToAll: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(currentFee);
  const [applyToAll, setApplyToAll] = useState(true);

  const differs = row.amount !== currentFee;

  useEffect(() => {
    if (open) {
      setSelected(currentFee);
      setApplyToAll(true);
    }
  }, [open, currentFee]);

  const options = useMemo(() => {
    const seen = new Set<number>();
    const list: { amount: number; label: string; current: boolean }[] = [];

    if (!seen.has(currentFee)) {
      seen.add(currentFee);
      list.push({
        amount: currentFee,
        current: true,
        label: "Current class fee",
      });
    }

    for (const entry of feeHistory) {
      if (seen.has(entry.amount)) continue;
      seen.add(entry.amount);
      list.push({
        amount: entry.amount,
        current: entry.isCurrent,
        label: `${formatStoredSriLankaDate(entry.effectiveFrom)} – ${
          entry.effectiveTo
            ? formatStoredSriLankaDate(entry.effectiveTo)
            : "Present"
        }`,
      });
    }

    if (!seen.has(row.amount)) {
      list.push({
        amount: row.amount,
        current: false,
        label: "This row's amount",
      });
    }

    return list;
  }, [feeHistory, currentFee, row.amount]);

  function confirmAndApply() {
    const scopeLabel = applyToAll
      ? `all ${studentCount} student${studentCount === 1 ? "" : "s"}`
      : row.studentName;

    if (
      window.confirm(
        `Update the amount for ${scopeLabel} to ${rupees(selected)}?`
      )
    ) {
      onApply(selected, applyToAll);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-slate-700">{rupees(row.amount)}</span>

        {paid ? (
          <span className="text-[10px] leading-tight text-slate-400">
            Locked — student has paid
          </span>
        ) : differs ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] leading-tight text-amber-600">
              Applied by the class fee before the due date
            </span>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="rounded border border-[#b9cfe3] bg-[#eef3f8] px-1.5 py-0.5 text-[10px] font-semibold text-[#264867] transition hover:bg-[#dce7f1]"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="w-fit text-[10px] font-medium text-slate-400 underline decoration-dotted underline-offset-2 hover:text-[#32598A]"
          >
            Change
          </button>
        )}
      </div>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-[min(16rem,calc(100vw-2.5rem))] rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Change amount
            </p>

            <div className="mt-1.5 max-h-44 space-y-1 overflow-y-auto scrollbar-thin">
              {options.map((option) => (
                <label
                  key={option.amount}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition ${
                    selected === option.amount
                      ? "border-[#8fb0cd] bg-[#eef3f8]"
                      : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="radio"
                    checked={selected === option.amount}
                    onChange={() => setSelected(option.amount)}
                  />
                  <span className="font-bold text-slate-900">
                    {rupees(option.amount)}
                  </span>
                  {option.current ? (
                    <span className="rounded-full bg-[#32598A] px-1.5 text-[9px] font-semibold text-white">
                      Current
                    </span>
                  ) : null}
                  <span className="ml-auto text-[9px] text-slate-400">
                    {option.label}
                  </span>
                </label>
              ))}
            </div>

            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(event) => setApplyToAll(event.target.checked)}
              />
              Apply to all students
            </label>

            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={confirmAndApply}
                className="rounded-md bg-[#32598A] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#264867] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Updating..." : "Update"}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function PaymentAccordion({
  payments,
  finalAmount,
  classId,
  onChanged,
}: {
  payments: FeePaymentDetail[];
  finalAmount: number;
  classId: string;
  onChanged: () => void | Promise<void>;
}) {
  if (payments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-3 text-xs text-slate-500">
        No payment submitted for this month yet.
        <span className="ml-1 text-slate-400">
          (Expected {rupees(finalAmount)})
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {payments.map((payment) => (
        <PaymentReviewCard
          key={payment.id}
          payment={payment}
          classId={classId}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function PaymentReviewCard({
  payment,
  classId,
  onChanged,
}: {
  payment: FeePaymentDetail;
  classId: string;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<null | "CONFIRMED" | "NEEDS_CLARIFICATION">(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const tone =
    payment.status === "CONFIRMED"
      ? "border-emerald-200 bg-emerald-50"
      : payment.status === "NEEDS_CLARIFICATION"
      ? "border-rose-200 bg-rose-50"
      : "border-amber-200 bg-amber-50";

  const label =
    payment.status === "CONFIRMED"
      ? "Confirmed"
      : payment.status === "NEEDS_CLARIFICATION"
      ? "Needs clarification"
      : "Pending review";

  async function act(status: "CONFIRMED" | "NEEDS_CLARIFICATION") {
    if (status === "NEEDS_CLARIFICATION" && feedback.trim().length < 3) {
      toast.error("Add a short note explaining what the student should fix.");
      return;
    }
    setBusy(status);
    try {
      const res = await fetch(`/api/classes/${classId}/payments/${payment.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, feedback: feedback.trim() || undefined }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message ?? "Action failed.");
      }
      toast.success(status === "CONFIRMED" ? "Payment confirmed." : "Clarification requested.");
      setShowFeedback(false);
      setFeedback("");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const canAct = payment.status !== "CONFIRMED";

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-slate-900">{rupees(payment.amount)}</span>
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
          {label}
        </span>
      </div>

      <div className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <p className="text-slate-600">
          Submitted: {formatStoredSriLankaDateTime(payment.submittedAt)}
        </p>
        {payment.confirmedAt ? (
          <p className="text-slate-600">
            Confirmed: {formatStoredSriLankaDateTime(payment.confirmedAt)}
          </p>
        ) : null}
      </div>

      {payment.note ? (
        <p className="mt-1.5 text-slate-700">
          <span className="font-semibold">Student note:</span> {payment.note}
        </p>
      ) : null}
      {payment.teacherFeedback ? (
        <p className="mt-0.5 text-slate-700">
          <span className="font-semibold">Your feedback:</span> {payment.teacherFeedback}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {payment.hasSlip ? (
          <a
            href={`/api/payments/${payment.id}/slip`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            <FileText size={11} />
            View slip <ExternalLink size={9} />
          </a>
        ) : (
          <span className="text-[11px] text-slate-400">No slip attached</span>
        )}

        {canAct ? (
          <>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act("CONFIRMED")}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <CheckCircle2 size={11} />
              {busy === "CONFIRMED" ? "Confirming…" : "Confirm payment"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setShowFeedback((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-50"
            >
              <MessageCircleWarning size={11} />
              Request clarification
            </button>
          </>
        ) : null}
      </div>

      {showFeedback && canAct ? (
        <div className="mt-2 rounded-lg border border-amber-200 bg-white p-2">
          <textarea
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should the student correct or re-send?"
            className="w-full resize-none rounded-md border border-amber-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-amber-400"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowFeedback(false)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act("NEEDS_CLARIFICATION")}
              className="rounded-lg bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy === "NEEDS_CLARIFICATION" ? "Sending…" : "Send request"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdjustInput({
  defaultValue,
  disabled,
  onCommit,
}: {
  defaultValue: number;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(String(defaultValue));
  const lastCommitted = useRef(String(defaultValue));

  useEffect(() => {
    setValue(String(defaultValue));
    lastCommitted.current = String(defaultValue);
  }, [defaultValue]);

  function commit() {
    if (value === lastCommitted.current) return;
    lastCommitted.current = value;
    onCommit(value);
  }

  return (
    <input
      type="number"
      min={0}
      inputMode="numeric"
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className="h-8 w-24 rounded-md border border-slate-200 px-2 text-xs text-slate-700 outline-none transition focus:border-[#3d6690] disabled:cursor-not-allowed disabled:bg-slate-50"
    />
  );
}
