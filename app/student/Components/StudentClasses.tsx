import {
  BookOpen,
  Calendar,
  CalendarDays,
  CalendarClock,
  Clock,
  FileText,
  History,
  Layers3,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";

import {
  ClassBookBadge,
  getClassBookLabel,
  getClassCardIcon,
  getClassCardTheme,
  getClassNumber,
} from "@/components/class-card-visuals";
import { formatStoredSriLankaDate, formatStoredSriLankaDateTime } from "@/lib/time";

interface ClassPaymentRecord {
  id: string;
  amount?: number | null;
  status: "CONFIRMED" | "PENDING" | "CLARIFICATION" | "NEEDS_CLARIFICATION";
  classStudentFee?: { year: number; month: number } | null;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function paymentPeriodLabel(fee?: { year: number; month: number } | null) {
  if (!fee) return "—";
  return `${MONTH_LABELS[fee.month - 1] ?? fee.month} ${fee.year}`;
}

function isPaidStatus(status: ClassPaymentRecord["status"]) {
  return status === "CONFIRMED";
}

interface ClassHistoryRecord {
  id: string;
  action: string;
  actionDate: string;
  reason?: string | null;
}

interface ClassInfo {
  id: string;
  name: string;
  description?: string | null;
  schedule: string;
  monthlyFee: number;
  payments: ClassPaymentRecord[];
  studentHistory: ClassHistoryRecord[];
}

interface StudentClass {
  id: string;
  isActive: boolean;
  assignedAt: string;
  removedAt?: string | null;
  removeReason?: string | null;
  class: ClassInfo;
}

interface GroupedClass {
  classId: string;
  info: ClassInfo;
  isActive: boolean;
  assignedAt: string;
  removedAt: string | null;
  removeReason: string | null;
  enrolmentCount: number;
  payments: ClassPaymentRecord[];
  history: ClassHistoryRecord[];
}

function groupByClass(rows: StudentClass[]): GroupedClass[] {
  const map = new Map<string, StudentClass[]>();

  for (const row of rows) {
    const key = row.class.id;
    const bucket = map.get(key);

    if (bucket) {
      bucket.push(row);
    } else {
      map.set(key, [row]);
    }
  }

  const groups: GroupedClass[] = [];

  for (const bucket of map.values()) {
    // Rows arrive newest-first from the API.
    const sorted = [...bucket].sort(
      (a, b) =>
        new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime()
    );

    const primary = sorted[0];
    const isActive = sorted.some((row) => row.isActive);

    const removedRow = sorted.find((row) => !row.isActive && row.removedAt);

    // Payments / history are filtered by student only, so they repeat across
    // every enrolment row for the same class — dedupe by id.
    const paymentMap = new Map<string, ClassPaymentRecord>();
    const historyMap = new Map<string, ClassHistoryRecord>();

    for (const row of sorted) {
      for (const payment of row.class.payments) {
        paymentMap.set(payment.id, payment);
      }
      for (const entry of row.class.studentHistory) {
        historyMap.set(entry.id, entry);
      }
    }

    const payments = [...paymentMap.values()].sort((a, b) => {
      const ay = a.classStudentFee
        ? a.classStudentFee.year * 100 + a.classStudentFee.month
        : 0;
      const by = b.classStudentFee
        ? b.classStudentFee.year * 100 + b.classStudentFee.month
        : 0;
      return by - ay;
    });

    const history = [...historyMap.values()].sort(
      (a, b) =>
        new Date(b.actionDate).getTime() - new Date(a.actionDate).getTime()
    );

    groups.push({
      classId: primary.class.id,
      info: primary.class,
      isActive,
      assignedAt: primary.assignedAt,
      removedAt: isActive ? null : removedRow?.removedAt ?? null,
      removeReason: isActive ? null : removedRow?.removeReason ?? null,
      enrolmentCount: sorted.length,
      payments,
      history,
    });
  }

  return groups.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime();
  });
}

interface StudentClassesProps {
  studentId: string;
  /** When provided by the parent page, the tab renders this instead of fetching. */
  data?: StudentClass[] | null;
}

export function StudentClasses({ studentId, data }: StudentClassesProps) {
  const controlled = data !== undefined;

  const [fetched, setFetched] = useState<StudentClass[] | null>(null);
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});

  const loadClasses = useCallback(async () => {
    if (!studentId) return;

    try {
      const response = await fetch(
        `/api/student/Profile/${studentId}/classes`
      );
      const result = await response.json();

      setFetched(result.success ? (result.data as StudentClass[]) : []);
    } catch (error) {
      console.error("Failed to load classes:", error);
      setFetched([]);
    }
  }, [studentId]);

  useEffect(() => {
    if (controlled) return;
    void loadClasses();
  }, [controlled, loadClasses]);

  const rows = controlled ? data : fetched;
  const loading = rows == null;
  const groups = useMemo(() => (rows ? groupByClass(rows) : []), [rows]);

  if (loading) {
    return (
      <div className="grid gap-3 lg:grid-cols-2">
        {[1, 2].map((item) => (
          <div
            key={item}
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="animate-pulse">
              <div className="h-[76px] bg-slate-200" />
              <div className="space-y-2 p-4">
                <div className="grid grid-cols-2 gap-2">
                  <div className="h-9 rounded-lg bg-slate-100" />
                  <div className="h-9 rounded-lg bg-slate-100" />
                </div>
                <div className="h-14 rounded-lg bg-slate-100" />
                <div className="h-3 w-2/3 rounded bg-slate-100" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <BookOpen className="mx-auto mb-2 h-8 w-8 text-slate-400" />
        <h3 className="text-[13px] font-semibold text-slate-900">
          No classes assigned
        </h3>
        <p className="mt-1 text-[12px] text-slate-500">
          This student has not been assigned to any classes yet.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {groups.map((group) => {
        const historyOpen = openHistory[group.classId] ?? false;
        const confirmedPayments = group.payments.filter((p) =>
          isPaidStatus(p.status)
        ).length;

        const theme = getClassCardTheme(group.classId);
        const ClassIcon = getClassCardIcon(group.classId);
        const bookLabel = getClassBookLabel(group.info.name);
        const bookNumber = getClassNumber(group.info.name);

        return (
          <div
            key={group.classId}
            className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-transparent transition-all duration-300 hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-lg hover:ring-teal-100"
          >
            {/* Header */}
            <div
              className={`relative overflow-hidden bg-gradient-to-br ${theme.gradient} py-3 pl-4 pr-36 text-white`}
            >
              <div
                className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full ${theme.glow1} blur-2xl`}
              />
              <div
                className={`pointer-events-none absolute -bottom-12 left-10 h-28 w-28 rounded-full ${theme.glow2} blur-2xl`}
              />

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
                    <h3 className="truncate text-sm font-bold leading-tight tracking-tight text-white">
                      {group.info.name}
                    </h3>

                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                        group.isActive
                          ? `${theme.badgeBorder} ${theme.badgeBg} ${theme.badgeText}`
                          : "border-rose-200/40 bg-rose-500/20 text-rose-50"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          group.isActive ? theme.badgeDot : "bg-rose-300"
                        }`}
                      />
                      {group.isActive ? "Active" : "Removed"}
                    </span>
                  </div>

                  <div
                    className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${theme.metaText}`}
                  >
                    <Layers3 size={10} />
                    General
                    {group.enrolmentCount > 1 && (
                      <span className="ml-1 rounded-full bg-white/15 px-1.5 py-px text-[9px]">
                        {group.enrolmentCount} enrolments
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="relative mt-2 flex items-center justify-between border-t border-white/10 pt-2">
                <span className={`flex items-center gap-1 text-[10px] ${theme.metaText}`}>
                  <CalendarClock size={11} />
                  Assigned {formatStoredSriLankaDate(group.assignedAt)}
                </span>

                {!group.isActive && group.removedAt && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-rose-50 backdrop-blur">
                    Removed {formatStoredSriLankaDate(group.removedAt)}
                  </span>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Left: details */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-teal-200">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-teal-100 text-teal-700">
                      <Wallet size={13} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                        Monthly Fee
                      </p>
                      <p className="truncate text-sm font-bold text-slate-900">
                        Rs. {group.info.monthlyFee.toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-sky-200">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-600">
                      <ReceiptText size={13} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                        Payments
                      </p>
                      <p className="truncate text-sm font-bold text-slate-900">
                        {confirmedPayments}
                        <span className="text-[11px] font-medium text-slate-400">
                          {" "}
                          / {group.payments.length} paid
                        </span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 p-2 transition-colors group-hover:border-blue-200">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-700">
                      <Calendar size={13} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                        Enrolled Since
                      </p>
                      <p className="truncate text-sm font-bold text-slate-900">
                        {formatStoredSriLankaDate(group.assignedAt)}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Right: schedule */}
                <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                  <div className="mb-2 flex items-center gap-1.5">
                    <div className="flex h-5 w-5 items-center justify-center rounded-md bg-blue-900/10">
                      <CalendarDays className="h-3 w-3 text-blue-900" />
                    </div>
                    <span className="text-xs font-semibold text-slate-800">
                      Weekly Schedule
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 rounded-md border border-slate-100 bg-white px-2 py-1.5 shadow-sm">
                    <Clock size={10} className="shrink-0 text-teal-600" />
                    <span className="text-[10px] font-medium text-slate-500">
                      {group.info.schedule || "Schedule not available"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="flex items-start gap-1.5">
                <FileText size={12} className="mt-0.5 shrink-0 text-slate-400" />
                <p className="line-clamp-2 text-xs leading-5 text-slate-600">
                  {group.info.description || "No class description provided."}
                </p>
              </div>

              {/* Payments */}
              <div className="rounded-lg border border-slate-100 bg-white">
                <div className="flex items-center justify-between border-b border-slate-100 px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-slate-700">
                    Payment Records
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                    {group.payments.length}
                  </span>
                </div>

                {group.payments.length === 0 ? (
                  <p className="px-2.5 py-2 text-[11px] text-slate-400">
                    No payments recorded.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-50">
                    {group.payments.slice(0, 4).map((payment) => (
                      <li
                        key={payment.id}
                        className="flex items-center justify-between px-2.5 py-1.5"
                      >
                        <span className="text-[11px] font-medium text-slate-600">
                          {paymentPeriodLabel(payment.classStudentFee)}
                        </span>

                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                            isPaidStatus(payment.status)
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {payment.status.replace(
                            "NEEDS_CLARIFICATION",
                            "CLARIFICATION"
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {group.payments.length > 4 && (
                  <p className="border-t border-slate-50 px-2.5 py-1 text-[10px] text-slate-400">
                    +{group.payments.length - 4} more
                  </p>
                )}
              </div>

              {/* Assignment history */}
              <div className="mt-auto rounded-lg border border-slate-100 bg-white">
                <button
                  type="button"
                  onClick={() =>
                    setOpenHistory((prev) => ({
                      ...prev,
                      [group.classId]: !historyOpen,
                    }))
                  }
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-left"
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
                    <History size={11} className="text-slate-400" />
                    Assignment History
                    <span className="rounded-full bg-slate-100 px-1.5 py-px text-[9px] font-semibold text-slate-500">
                      {group.history.length}
                    </span>
                  </span>
                  <span className="text-[10px] font-medium text-teal-700">
                    {historyOpen ? "Hide" : "Show"}
                  </span>
                </button>

                {historyOpen && (
                  <div className="border-t border-slate-100 px-2.5 py-2">
                    {group.history.length === 0 ? (
                      <p className="text-[11px] text-slate-400">
                        No history recorded.
                      </p>
                    ) : (
                      <ol className="space-y-2">
                        {group.history.map((entry) => (
                          <li key={entry.id} className="flex gap-2">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" />
                            <div className="min-w-0">
                              <p className="text-[11px] font-semibold text-slate-800">
                                {entry.action}
                              </p>
                              <p className="text-[10px] text-slate-400">
                                {formatStoredSriLankaDateTime(entry.actionDate)}
                              </p>
                              {entry.reason && (
                                <p className="mt-0.5 text-[10px] text-rose-600">
                                  Reason: {entry.reason}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
