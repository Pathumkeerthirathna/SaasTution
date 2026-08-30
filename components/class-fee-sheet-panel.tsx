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
} from "lucide-react";

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
  const [classId, setClassId] = useState("");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [sheet, setSheet] = useState<FeeSheet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savingFeeId, setSavingFeeId] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [feeHistory, setFeeHistory] = useState<ClassFeeHistoryEntry[]>([]);

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

  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  const isFutureSelection =
    year > nowYear || (year === nowYear && month > nowMonth);
  const willProcess = !isFutureSelection;

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

        const list = payload.data ?? [];
        setClasses(list);

        if (list.length > 0) {
          setClassId((current) => current || list[0].id);
        }
      } catch {
        if (!cancelled) {
          setErrorMessage("Failed to load classes.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <section className="space-y-4">
      <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-white">
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
              {classes.length === 0 ? (
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
                          ? "bg-teal-600 text-white shadow-sm"
                          : "bg-white text-slate-600 hover:bg-teal-50"
                      }`}
                    >
                      <BookOpen
                        size={12}
                        className={selected ? "text-white" : "text-slate-400"}
                      />
                      <span className="truncate">{item.name}</span>
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
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
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
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

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
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-teal-200 bg-teal-50/60 py-8 text-sm font-medium text-teal-700">
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700 transition hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-60"
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
            <div className="overflow-x-auto rounded-lg border border-slate-200">
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
          )}
          </>
        ) : null}
      </article>
    </section>
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
              className="rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 transition hover:bg-teal-100"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="w-fit text-[10px] font-medium text-slate-400 underline decoration-dotted underline-offset-2 hover:text-teal-600"
          >
            Change
          </button>
        )}
      </div>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Change amount
            </p>

            <div className="mt-1.5 max-h-44 space-y-1 overflow-y-auto scrollbar-thin">
              {options.map((option) => (
                <label
                  key={option.amount}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition ${
                    selected === option.amount
                      ? "border-teal-300 bg-teal-50"
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
                    <span className="rounded-full bg-teal-600 px-1.5 text-[9px] font-semibold text-white">
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
                className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
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
}: {
  payments: FeePaymentDetail[];
  finalAmount: number;
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
      {payments.map((payment) => {
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
            : "Pending";

        return (
          <div
            key={payment.id}
            className={`rounded-lg border px-3 py-2.5 text-xs ${tone}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-900">
                {rupees(payment.amount)}
              </span>
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
              {payment.hasSlip ? (
                <p className="inline-flex items-center gap-1 text-slate-600">
                  <FileText size={11} />
                  Slip attached
                </p>
              ) : null}
            </div>

            {payment.note ? (
              <p className="mt-1.5 text-slate-700">
                <span className="font-semibold">Note:</span> {payment.note}
              </p>
            ) : null}
            {payment.teacherFeedback ? (
              <p className="mt-0.5 text-slate-700">
                <span className="font-semibold">Teacher feedback:</span>{" "}
                {payment.teacherFeedback}
              </p>
            ) : null}
          </div>
        );
      })}
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
      className="h-8 w-24 rounded-md border border-slate-200 px-2 text-xs text-slate-700 outline-none transition focus:border-teal-500 disabled:cursor-not-allowed disabled:bg-slate-50"
    />
  );
}
