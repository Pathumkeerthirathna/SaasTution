"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  ClipboardCheck,
  CreditCard,
  FileText,
  GraduationCap,
  LayoutDashboard,
  NotebookPen,
  UserRound,
} from "lucide-react";

type GuardianStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  grade: string | null;
  relation: string;
  classCount: number;
};

type ApiEnvelope<T> = { success: boolean; data?: T; error?: { message?: string } };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const payload = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || payload.success === false || payload.data === undefined) {
    throw new Error(payload.error?.message ?? "Request failed.");
  }
  return payload.data;
}

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "classes", label: "Classes", icon: GraduationCap },
  { id: "payments", label: "Payments", icon: CreditCard },
  { id: "attendance", label: "Attendance", icon: CalendarCheck },
  { id: "papers", label: "Papers", icon: FileText },
  { id: "assignments", label: "Assignments", icon: NotebookPen },
  { id: "quizzes", label: "Quizzes", icon: ClipboardCheck },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function GuardianPortal({ guardianName }: { guardianName: string }) {
  const [students, setStudents] = useState<GuardianStudent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  useEffect(() => {
    getJson<GuardianStudent[]>("/api/guardian/students")
      .then((data) => {
        setStudents(data);
        setSelectedId((prev) => prev ?? data[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load students."));
  }, []);

  const selected = useMemo(
    () => students?.find((s) => s.id === selectedId) ?? null,
    [students, selectedId]
  );

  return (
    <section className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Left: student list (~1/4) */}
      <aside className="w-full shrink-0 lg:w-1/4">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Signed in as
            </p>
            <p className="truncate text-[13px] font-semibold text-slate-800">
              {guardianName}
            </p>
          </div>

          <div className="p-2">
            <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              My students {students ? `(${students.length})` : ""}
            </p>

            {error ? (
              <p className="m-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-[12px] text-rose-700">
                {error}
              </p>
            ) : !students ? (
              <p className="px-3 py-6 text-center text-[12px] text-slate-400">Loading…</p>
            ) : students.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-slate-400">
                No students are linked to your account yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {students.map((student) => {
                  const active = student.id === selectedId;
                  return (
                    <li key={student.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(student.id);
                          setActiveTab("overview");
                        }}
                        className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
                          active
                            ? "border-teal-300 bg-teal-50"
                            : "border-transparent hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                            active ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          <UserRound size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold text-slate-900">
                            {student.name}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                            {student.registrationNumber ?? "No reg. no"}
                            {student.grade ? ` · ${student.grade}` : ""}
                          </span>
                          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">
                            {student.relation} · {student.classCount}{" "}
                            {student.classCount === 1 ? "class" : "classes"}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </aside>

      {/* Right: selected student */}
      <div className="min-w-0 flex-1">
        {!selected ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-[13px] text-slate-400">
            Select a student to view their progress.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <h2 className="text-[17px] font-bold text-slate-900">{selected.name}</h2>
              <p className="mt-0.5 text-[12.5px] text-slate-500">
                {selected.registrationNumber ?? "No registration number"}
                {selected.grade ? ` · ${selected.grade}` : ""} · You are the{" "}
                {selected.relation}
              </p>
            </div>

            <div className="border-b border-slate-200">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {TABS.map((tab) => {
                  const Icon = tab.icon;
                  const active = tab.id === activeTab;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex shrink-0 items-center gap-1.5 border-b-2 px-1 py-2 text-[12px] font-medium transition-colors ${
                        active
                          ? "border-teal-600 text-teal-700"
                          : "border-transparent text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      <Icon size={14} />
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <GuardianTab studentId={selected.id} tab={activeTab} />
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tab dispatch                                                        */
/* ------------------------------------------------------------------ */

function GuardianTab({ studentId, tab }: { studentId: string; tab: TabId }) {
  switch (tab) {
    case "overview":
      return <OverviewTab studentId={studentId} />;
    case "classes":
      return <ClassesTab studentId={studentId} />;
    case "payments":
      return <PaymentsTab studentId={studentId} />;
    case "attendance":
      return <AttendanceTab studentId={studentId} />;
    case "papers":
      return <PapersTab studentId={studentId} />;
    case "assignments":
      return <AssignmentsTab studentId={studentId} />;
    case "quizzes":
      return <QuizzesTab studentId={studentId} />;
    default:
      return null;
  }
}

function useTabData<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setData(null);
    setError(null);
    getJson<T>(url)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load."));
  }, [url]);

  useEffect(reload, [reload]);

  return { data, error, reload };
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">{children}</div>
  );
}

function Loading() {
  return <p className="py-10 text-center text-[12px] text-slate-400">Loading…</p>;
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
      {message}
    </p>
  );
}

function pct(n: number) {
  return `${Math.round(n)}%`;
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

type TrendMonth = { label: string; percent: number };

type OverviewData = {
  attendance: { rate: number; trendDelta: number; months: TrendMonth[] };
  quiz: { averageScore: number; trendDelta: number; months: TrendMonth[] };
  payments: {
    paidCount: number;
    unpaidCount: number;
    paidAmount: number;
    unpaidAmount: number;
    paidPercent: number;
    overdueFees: number;
  };
};

function OverviewTab({ studentId }: { studentId: string }) {
  const { data, error } = useTabData<OverviewData>(
    `/api/guardian/students/${studentId}/overview`
  );

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const attMonths = data.attendance?.months ?? [];
  const quizMonths = data.quiz?.months ?? [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-slate-900">Attendance by month</h3>
          <span className="text-[12px] font-bold text-teal-700">
            {pct(data.attendance.rate)} overall
          </span>
        </div>
        {attMonths.every((m) => m.percent === 0) ? (
          <p className="mt-3 text-[12px] text-slate-400">No attendance data yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {attMonths.map((m) => (
              <li key={m.label} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-slate-500">{m.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-teal-500"
                    style={{ width: pct(m.percent) }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-[11px] font-semibold text-slate-700">
                  {pct(m.percent)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-slate-900">Quiz results trend</h3>
          <span className="text-[12px] font-bold text-indigo-700">
            {pct(data.quiz.averageScore)} avg
          </span>
        </div>
        {quizMonths.every((m) => m.percent === 0) ? (
          <p className="mt-3 text-[12px] text-slate-400">No quiz data yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {quizMonths.map((m, i) => (
              <li key={`${m.label}-${i}`} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-slate-500">{m.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-indigo-500"
                    style={{ width: pct(m.percent) }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-[11px] font-semibold text-slate-700">
                  {pct(m.percent)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="text-[13px] font-semibold text-slate-900">Payment standing</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 text-center">
          <Stat label="Paid" value={String(data.payments.paidCount)} tone="ok" />
          <Stat label="Not paid" value={String(data.payments.unpaidCount)} tone="warn" />
          <Stat
            label="Paid amount"
            value={`Rs. ${data.payments.paidAmount.toLocaleString()}`}
            tone="ok"
          />
          <Stat
            label="Outstanding"
            value={`Rs. ${data.payments.unpaidAmount.toLocaleString()}`}
            tone="warn"
          />
        </div>
        {data.payments.overdueFees > 0 ? (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] font-medium text-rose-700">
            {data.payments.overdueFees} overdue{" "}
            {data.payments.overdueFees === 1 ? "payment" : "payments"}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn";
}) {
  return (
    <div
      className={`rounded-lg border px-2 py-2 ${
        tone === "ok"
          ? "border-emerald-100 bg-emerald-50"
          : "border-amber-100 bg-amber-50"
      }`}
    >
      <p className="text-[15px] font-bold text-slate-900">{value}</p>
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Classes                                                             */
/* ------------------------------------------------------------------ */

type ClassRow = {
  id: string;
  class: { id: string; name: string; description: string | null; schedule: string; monthlyFee: number };
  isActive: boolean;
};

function ClassesTab({ studentId }: { studentId: string }) {
  const { data, error } = useTabData<ClassRow[]>(
    `/api/guardian/students/${studentId}/classes`
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const active = data.filter((c) => c.isActive);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {active.length === 0 ? (
        <p className="text-[12px] text-slate-400">Not enrolled in any classes.</p>
      ) : (
        active.map((row) => (
          <Card key={row.id}>
            <h3 className="text-[13px] font-semibold text-slate-900">{row.class.name}</h3>
            <p className="mt-1 text-[11px] text-slate-500">{row.class.schedule}</p>
            {row.class.description ? (
              <p className="mt-2 line-clamp-3 text-[12px] text-slate-600">
                {row.class.description}
              </p>
            ) : null}
            <p className="mt-2 text-[12px] font-semibold text-slate-700">
              Rs. {row.class.monthlyFee.toLocaleString()} / month
            </p>
          </Card>
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

type PaymentFee = {
  id: string;
  year: number;
  month: number;
  monthLabel: string;
  finalAmount: number;
  dueDate: string | null;
  paid: boolean;
  dueStatus: "OVERDUE" | "DUE_SOON" | "UPCOMING" | null;
};

type PaymentsData = {
  summary: {
    paidCount: number;
    unpaidCount: number;
    paidAmount: number;
    unpaidAmount: number;
    paidPercent: number;
  };
  classes: Array<{ classId: string; className: string; fees: PaymentFee[] }>;
  years: number[];
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function PaymentsTab({ studentId }: { studentId: string }) {
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");

  const query = new URLSearchParams();
  if (year) query.set("year", year);
  if (month) query.set("month", month);

  const { data, error } = useTabData<PaymentsData>(
    `/api/guardian/students/${studentId}/payments?${query.toString()}`
  );

  const allFees = (data?.classes ?? []).flatMap((c) =>
    c.fees.map((f) => ({ ...f, className: c.className }))
  );
  const unpaid = allFees.filter((f) => !f.paid);
  const paid = allFees.filter((f) => f.paid);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-[12px]"
        >
          <option value="">All years</option>
          {(data?.years ?? []).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-[12px]"
        >
          <option value="">All months</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <ErrorBox message={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Paid" value={String(data.summary.paidCount)} tone="ok" />
            <Stat label="Not paid" value={String(data.summary.unpaidCount)} tone="warn" />
            <Stat
              label="Collected"
              value={`Rs. ${data.summary.paidAmount.toLocaleString()}`}
              tone="ok"
            />
            <Stat
              label="Outstanding"
              value={`Rs. ${data.summary.unpaidAmount.toLocaleString()}`}
              tone="warn"
            />
          </div>

          <PaymentGroup title="Not paid" fees={unpaid} emptyText="Nothing outstanding." />
          <PaymentGroup title="Paid" fees={paid} emptyText="No payments recorded." />
        </>
      )}
    </div>
  );
}

function PaymentGroup({
  title,
  fees,
  emptyText,
}: {
  title: string;
  fees: Array<PaymentFee & { className: string }>;
  emptyText: string;
}) {
  return (
    <Card>
      <h3 className="text-[13px] font-semibold text-slate-900">
        {title} <span className="text-slate-400">({fees.length})</span>
      </h3>
      {fees.length === 0 ? (
        <p className="mt-2 text-[12px] text-slate-400">{emptyText}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {fees.map((fee) => (
            <li key={fee.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium text-slate-800">
                  {fee.className}
                </p>
                <p className="text-[11px] text-slate-500">{fee.monthLabel}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {fee.dueStatus === "OVERDUE" ? (
                  <span className="rounded-full bg-rose-100 px-2 py-px text-[10px] font-semibold text-rose-700">
                    Due
                  </span>
                ) : fee.dueStatus === "DUE_SOON" ? (
                  <span className="rounded-full bg-amber-100 px-2 py-px text-[10px] font-semibold text-amber-700">
                    Due soon
                  </span>
                ) : null}
                <span className="text-[12.5px] font-semibold text-slate-900">
                  Rs. {fee.finalAmount.toLocaleString()}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

type AttendanceData = {
  summary: Array<{
    classId: string;
    className: string;
    totalLectures: number;
    attendedLectures: number;
    missedLectures: number;
    attendancePercentage: number;
  }>;
  analytics: { months?: Array<{ label: string; attendancePercentage: number }> };
};

function AttendanceTab({ studentId }: { studentId: string }) {
  const [classId, setClassId] = useState("");
  const { data, error } = useTabData<AttendanceData>(
    `/api/guardian/students/${studentId}/attendance`
  );

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const rows = data.summary.filter((r) => !classId || r.classId === classId);

  return (
    <div className="space-y-4">
      <select
        value={classId}
        onChange={(e) => setClassId(e.target.value)}
        className="h-8 rounded-md border border-slate-200 px-2 text-[12px]"
      >
        <option value="">All classes</option>
        {data.summary.map((r) => (
          <option key={r.classId} value={r.classId}>
            {r.className}
          </option>
        ))}
      </select>

      <div className="grid gap-3 sm:grid-cols-2">
        {rows.length === 0 ? (
          <p className="text-[12px] text-slate-400">No attendance records.</p>
        ) : (
          rows.map((r) => (
            <Card key={r.classId}>
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-slate-900">{r.className}</h3>
                <span className="text-[13px] font-bold text-teal-700">
                  {pct(r.attendancePercentage)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {r.attendedLectures} attended · {r.missedLectures} missed ·{" "}
                {r.totalLectures} total
              </p>
              <span className="mt-2 block h-2 overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full bg-teal-500"
                  style={{ width: pct(r.attendancePercentage) }}
                />
              </span>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Papers                                                              */
/* ------------------------------------------------------------------ */

type PapersData = {
  papers: Array<{
    id: string;
    name: string;
    className: string;
    classId: string;
    startTime: string;
    maxMarks: number | null;
    submitted: boolean;
    marks: number | null;
  }>;
  summary: { total: number; submitted: number; marked: number; averagePct: number | null };
};

function PapersTab({ studentId }: { studentId: string }) {
  const [classId, setClassId] = useState("");
  const { data, error } = useTabData<PapersData>(
    `/api/guardian/students/${studentId}/papers`
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const classes = Array.from(
    new Map(data.papers.map((p) => [p.classId, p.className])).entries()
  );
  const rows = data.papers.filter((p) => !classId || p.classId === classId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-[12px]"
        >
          <option value="">All classes</option>
          {classes.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-500">
          {data.summary.marked} marked · avg{" "}
          {data.summary.averagePct != null ? `${data.summary.averagePct}%` : "—"}
        </p>
      </div>

      <Card>
        {rows.length === 0 ? (
          <p className="text-[12px] text-slate-400">No papers.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium text-slate-800">{p.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {p.className} ·{" "}
                    {new Date(p.startTime).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {p.marks != null ? (
                    <span className="text-[12.5px] font-semibold text-slate-900">
                      {p.marks}
                      {p.maxMarks != null ? ` / ${p.maxMarks}` : ""}
                    </span>
                  ) : (
                    <span
                      className={`rounded-full px-2 py-px text-[10px] font-semibold ${
                        p.submitted
                          ? "bg-sky-100 text-sky-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {p.submitted ? "Awaiting marks" : "Not submitted"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Assignments                                                         */
/* ------------------------------------------------------------------ */

type AssignmentsData = {
  records: Array<{
    id: string;
    title: string;
    className: string;
    classId: string;
    dueDate: string;
    status: "not_submitted" | "submitted" | "marked";
    marks: number | null;
  }>;
  summary: { total: number; submitted: number; marked: number; missing: number };
};

function AssignmentsTab({ studentId }: { studentId: string }) {
  const [classId, setClassId] = useState("");
  const { data, error } = useTabData<AssignmentsData>(
    `/api/guardian/students/${studentId}/assignments`
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const classes = Array.from(
    new Map(data.records.map((r) => [r.classId, r.className])).entries()
  );
  const rows = data.records.filter((r) => !classId || r.classId === classId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-[12px]"
        >
          <option value="">All classes</option>
          {classes.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-500">
          {data.summary.marked} marked · {data.summary.missing} missing
        </p>
      </div>

      <Card>
        {rows.length === 0 ? (
          <p className="text-[12px] text-slate-400">No assignments.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium text-slate-800">{r.title}</p>
                  <p className="text-[11px] text-slate-500">
                    {r.className} · due{" "}
                    {new Date(r.dueDate).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {r.status === "marked" ? (
                    <span className="text-[12.5px] font-semibold text-slate-900">
                      {r.marks} marks
                    </span>
                  ) : (
                    <span
                      className={`rounded-full px-2 py-px text-[10px] font-semibold ${
                        r.status === "submitted"
                          ? "bg-sky-100 text-sky-700"
                          : "bg-rose-100 text-rose-700"
                      }`}
                    >
                      {r.status === "submitted" ? "Awaiting marks" : "Not submitted"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quizzes                                                             */
/* ------------------------------------------------------------------ */

type QuizzesData = {
  summary: { totalQuizzes: number; attempted: number; missed: number; averageScore: number };
  classes: Array<{
    classId: string;
    className: string;
    totalQuizzes: number;
    attempted: number;
    missed: number;
    averageScore: number;
  }>;
};

function QuizzesTab({ studentId }: { studentId: string }) {
  const [classId, setClassId] = useState("");
  const { data, error } = useTabData<{ summary: QuizzesData["summary"]; analytics: unknown } & QuizzesData>(
    `/api/guardian/students/${studentId}/quizzes`
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const rows = data.classes.filter((c) => !classId || c.classId === classId);

  return (
    <div className="space-y-4">
      <select
        value={classId}
        onChange={(e) => setClassId(e.target.value)}
        className="h-8 rounded-md border border-slate-200 px-2 text-[12px]"
      >
        <option value="">All classes</option>
        {data.classes.map((c) => (
          <option key={c.classId} value={c.classId}>
            {c.className}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Quizzes" value={String(data.summary.totalQuizzes)} tone="ok" />
        <Stat label="Attempted" value={String(data.summary.attempted)} tone="ok" />
        <Stat label="Missed" value={String(data.summary.missed)} tone="warn" />
        <Stat label="Avg score" value={pct(data.summary.averageScore)} tone="ok" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((c) => (
          <Card key={c.classId}>
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-slate-900">{c.className}</h3>
              <span className="text-[13px] font-bold text-indigo-700">
                {pct(c.averageScore)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {c.attempted} attempted · {c.missed} missed · {c.totalQuizzes} total
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
