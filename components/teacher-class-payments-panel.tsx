"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
  BookOpen,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  FileText,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  Upload,
  UserCircle2,
  Wallet,
  type LucideIcon,
} from "lucide-react";

type TeacherClass = {
  id: string;
  name: string;
  monthlyFee: number;
  paymentDueWeek: number;
};

type PaymentMessage = {
  id: string;
  senderRole: "STUDENT" | "TEACHER";
  senderName: string;
  message: string;
  proofFileName?: string | null;
  hasProofFile: boolean;
  createdAt: string;
};

type PaymentItem = {
  id: string;
  month: string;
  amount: number;
  note: string | null;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  teacherFeedback: string | null;
  submittedAt: string;
  confirmedAt: string | null;
  hasSlip: boolean;
  student: {
    id: string;
    name: string;
    registrationNumber: string | null;
  };
  messages: PaymentMessage[];
};

type PaymentSummary = {
  dueWeek: number;
  dueWeekLabel: string;
  dueDate: string;
  isPastDue: boolean;
  enrolledCount: number;
  submittedCount: number;
  confirmedCount: number;
  pendingCount: number;
  clarificationCount: number;
  defaulterCount: number;
  expectedAmount: number;
  submittedAmount: number;
  confirmedAmount: number;
};

type DefaulterItem = {
  id: string;
  name: string;
  registrationNumber: string | null;
};

const CLASS_CONFIG_UPDATED_EVENT = "saastution:class-config-updated";

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function statusClass(status: PaymentItem["status"]) {
  if (status === "CONFIRMED") return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (status === "NEEDS_CLARIFICATION") return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-brand-50 text-brand-700 border border-brand-200";
}

function getClassIcon(name: string): { Icon: LucideIcon; tone: string } {
  const normalized = name.toLowerCase();

  if (/(math|algebra|geometry|calculus|arith)/.test(normalized)) {
    return { Icon: CircleDollarSign, tone: "bg-blue-100 text-blue-700" };
  }
  if (/(science|chem|biology|bio|physics|lab)/.test(normalized)) {
    return { Icon: Wallet, tone: "bg-emerald-100 text-emerald-700" };
  }

  return { Icon: BookOpen, tone: "bg-brand-100 text-brand-700" };
}

export function TeacherClassPaymentsPanel() {
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [month, setMonth] = useState(getCurrentMonthKey());
  const [isLoadingClasses, setIsLoadingClasses] = useState(false);
  const [isLoadingPayments, setIsLoadingPayments] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [summary, setSummary] = useState<PaymentSummary | null>(null);
  const [defaulters, setDefaulters] = useState<DefaulterItem[]>([]);
  const [issueText, setIssueText] = useState<Record<string, string>>({});
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replyFile, setReplyFile] = useState<Record<string, File | null>>({});

  const selectedClass = useMemo(
    () => classes.find((item) => item.id === selectedClassId) ?? null,
    [classes, selectedClassId]
  );
  const selectedClassIcon = useMemo(() => getClassIcon(selectedClass?.name ?? "class"), [selectedClass?.name]);

  async function loadClasses() {
    setIsLoadingClasses(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/classes?page=1&pageSize=100`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: TeacherClass[];
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to load classes.");
        return;
      }

      const next = payload.data ?? [];
      setClasses(next);
      setSelectedClassId((prev) => prev || next[0]?.id || "");
    } catch {
      setErrorMessage("Unable to load classes right now.");
    } finally {
      setIsLoadingClasses(false);
    }
  }

  async function loadPayments(classId: string, monthKey: string) {
    if (!classId) {
      setPayments([]);
      setSummary(null);
      setDefaulters([]);
      return;
    }

    setIsLoadingPayments(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/classes/${classId}/payments?month=${encodeURIComponent(monthKey)}`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          payments: PaymentItem[];
          summary: PaymentSummary;
          defaulters: DefaulterItem[];
        };
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to load payments.");
        return;
      }

      setPayments(payload.data?.payments ?? []);
      setSummary(payload.data?.summary ?? null);
      setDefaulters(payload.data?.defaulters ?? []);
    } catch {
      setErrorMessage("Unable to load payments right now.");
    } finally {
      setIsLoadingPayments(false);
    }
  }

  useEffect(() => {
    void loadClasses();
  }, []);

  useEffect(() => {
    if (!selectedClassId) return;
    void loadPayments(selectedClassId, month);
  }, [selectedClassId, month]);

  useEffect(() => {
    function handleClassConfigUpdated() {
      void loadClasses();
      if (selectedClassId) {
        void loadPayments(selectedClassId, month);
      }
    }

    window.addEventListener(CLASS_CONFIG_UPDATED_EVENT, handleClassConfigUpdated);
    return () => window.removeEventListener(CLASS_CONFIG_UPDATED_EVENT, handleClassConfigUpdated);
  }, [selectedClassId, month]);

  async function confirmPayment(paymentId: string) {
    if (!selectedClassId) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${selectedClassId}/payments/${paymentId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CONFIRMED" }),
      });

      const payload = (await response.json()) as { success: boolean; error?: { message?: string } };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to confirm payment.");
        return;
      }

      setSuccessMessage("Payment confirmed.");
      await loadPayments(selectedClassId, month);
    } catch {
      setErrorMessage("Unable to confirm payment right now.");
    } finally {
      setIsSaving(false);
    }
  }

  async function requestClarification(paymentId: string) {
    if (!selectedClassId) return;
    const feedback = issueText[paymentId]?.trim() || "";

    if (!feedback) {
      setErrorMessage("Please enter what needs clarification.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/classes/${selectedClassId}/payments/${paymentId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "NEEDS_CLARIFICATION", feedback }),
      });

      const payload = (await response.json()) as { success: boolean; error?: { message?: string } };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to request clarification.");
        return;
      }

      setSuccessMessage("Clarification sent to student.");
      setIssueText((prev) => ({ ...prev, [paymentId]: "" }));
      await loadPayments(selectedClassId, month);
    } catch {
      setErrorMessage("Unable to send clarification right now.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>, paymentId: string) {
    event.preventDefault();
    if (!selectedClassId) return;

    const message = replyText[paymentId]?.trim() || "";
    const file = replyFile[paymentId] ?? null;

    if (!message && !file) {
      setErrorMessage("Add a message or proof file.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const formData = new FormData();
      formData.set("message", message);
      if (file) formData.set("proof", file);

      const response = await fetch(`/api/classes/${selectedClassId}/payments/${paymentId}/messages`, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as { success: boolean; error?: { message?: string } };
      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to send message.");
        return;
      }

      setSuccessMessage("Message sent.");
      setReplyText((prev) => ({ ...prev, [paymentId]: "" }));
      setReplyFile((prev) => ({ ...prev, [paymentId]: null }));
      await loadPayments(selectedClassId, month);
    } catch {
      setErrorMessage("Unable to send message right now.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="panel-shell mt-6 rounded-xl p-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Class Payments</h2>
          <p className="text-sm text-muted">Review monthly student payments, confirm them, or request clarification.</p>
        </div>
        {selectedClass ? (
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-700">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${selectedClassIcon.tone}`}>
              <selectedClassIcon.Icon size={14} />
            </span>
            <span>Default fee: Rs {selectedClass.monthlyFee.toLocaleString()} · Due week {selectedClass.paymentDueWeek}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_auto] md:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Class</label>
          <div className="relative">
            <BookOpen size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <select
              value={selectedClassId}
              onChange={(event) => setSelectedClassId(event.target.value)}
              className="control-select pl-9 h-10
rounded-md
border-slate-200
text-sm"
              disabled={isLoadingClasses}
            >
              <option value="">Select class</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {` (Week ${item.paymentDueWeek})`}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Month</label>
          <div className="relative">
            <CalendarDays size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="control-input pl-9" />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadPayments(selectedClassId, month)}
          className="btn-primary h-9
rounded-md
px-3
text-sm"
          disabled={!selectedClassId || isLoadingPayments}
        >
          <RefreshCw size={14} className={isLoadingPayments ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {errorMessage ? <p className="notice-error mt-4">{errorMessage}</p> : null}
      {successMessage ? <p className="notice-success mt-4">{successMessage}</p> : null}

      {isLoadingPayments ? (
        <p className="mt-5 inline-flex items-center gap-2 text-sm text-muted"><LoaderCircle size={15} className="animate-spin" />Loading payments...</p>
      ) : null}
      {!isLoadingPayments && selectedClassId && payments.length === 0 ? (
        <p className="notice-info mt-5 inline-flex items-center gap-2"><BadgeCheck size={15} />No payment submissions for selected month.</p>
      ) : null}

      {summary ? (
        <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <article
  className="
    rounded-lg
    border
    border-slate-200
    bg-white
    p-4
  "
>
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Clock3 size={13} />Due Window</p>
            <p className="mt-2 text-sm text-muted">{summary.dueWeekLabel} of selected month</p>
            <p className="mt-1 text-sm text-muted">Due date: <span className="font-semibold text-foreground">{new Date(summary.dueDate).toLocaleDateString()}</span></p>
            <p className={`mt-1 text-xs font-semibold ${summary.isPastDue ? "text-rose-700" : "text-emerald-700"}`}>
              {summary.isPastDue ? "Past due period" : "Within due period"}
            </p>
          </article>

          <article className="surface-soft p-4">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><CircleDollarSign size={13} />Monthly Amounts</p>
            <p className="mt-2 text-sm text-muted">Expected: <span className="font-semibold text-foreground">Rs {summary.expectedAmount.toLocaleString()}</span></p>
            <p className="mt-1 text-sm text-muted">Submitted: <span className="font-semibold text-brand-700">Rs {summary.submittedAmount.toLocaleString()}</span></p>
            <p className="mt-1 text-sm text-muted">Confirmed: <span className="font-semibold text-emerald-700">Rs {summary.confirmedAmount.toLocaleString()}</span></p>
          </article>

          <article className="surface-soft p-4">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Wallet size={13} />Payment Status Counts</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 font-semibold text-brand-700">Submitted {summary.submittedCount}</span>
              <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700">Confirmed {summary.confirmedCount}</span>
              <span className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 font-semibold text-amber-700">Pending {summary.pendingCount}</span>
              <span className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 font-semibold text-rose-700">Clarification {summary.clarificationCount}</span>
            </div>
            <p className="mt-2 text-xs text-muted">Active students: {summary.enrolledCount}</p>
          </article>

          <article className="surface-soft p-4">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><ShieldAlert size={13} />Defaulters ({summary.defaulterCount})</p>
            {defaulters.length === 0 ? (
              <p className="mt-2 text-sm text-emerald-700">No defaulters for this month.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm text-muted">
                {defaulters.map((student) => (
                  <li key={student.id} className="
                          rounded-md
                          border
                          border-slate-200
                          bg-white
                          px-3
                          py-2
                          ">
                    <span className="font-semibold text-foreground">{student.name}</span>
                    {student.registrationNumber ? (
                      <span className="ml-1 text-xs text-muted">({student.registrationNumber})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      ) : null}

      <div className="mt-5 space-y-4">
        {payments.map((payment) => (
          <article
  key={payment.id}
  className="
    rounded-lg
    border
    border-slate-200
    bg-white
    p-4
    shadow-sm
  "
>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <UserCircle2 size={15} className="text-brand-600" />
                  {payment.student.name}
                  {payment.student.registrationNumber ? (
                    <span className="ml-1 text-xs font-normal text-muted">({payment.student.registrationNumber})</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted">Submitted: {new Date(payment.submittedAt).toLocaleString()}</p>
                <p className="mt-1 text-sm font-medium text-brand-700">Amount: Rs {payment.amount.toLocaleString()}</p>
              </div>
              <span className={`rounded-md px-2.5 py-1 text-xs font-semibold ${statusClass(payment.status)}`}>{payment.status.replaceAll("_", " ")}</span>
            </div>

            {payment.note ? <p className="mt-2 text-sm text-muted">{payment.note}</p> : null}
            {payment.hasSlip ? (
              <a href={`/api/payments/${payment.id}/slip`} className="btn-ghost mt-3 inline-flex items-center gap-2 text-xs" target="_blank" rel="noreferrer">
                <FileText size={13} />
                View payment slip
              </a>
            ) : (
              <p className="mt-3 text-xs text-muted">No slip uploaded.</p>
            )}

            {payment.teacherFeedback ? (
              <div className="notice-error mt-3">Teacher note: {payment.teacherFeedback}</div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void confirmPayment(payment.id)} className="btn-primary gap-2" disabled={isSaving || payment.status === "CONFIRMED"}>
                <BadgeCheck size={14} />
                Confirm
              </button>
              <button type="button" onClick={() => void requestClarification(payment.id)} className="btn-secondary gap-2" disabled={isSaving}>
                <AlertCircle size={14} />
                Request clarification
              </button>
            </div>

            <textarea
              rows={2}
              value={issueText[payment.id] ?? ""}
              onChange={(event) => setIssueText((prev) => ({ ...prev, [payment.id]: event.target.value }))}
              className="control-textarea mt-2"
              placeholder="Write what needs to be corrected"
            />

            <div className="mt-4 space-y-2">
              {payment.messages.map((message) => (
                <div
  key={message.id}
  className="
    rounded-md
    border
    border-slate-200
    bg-slate-50
    px-3
    py-2
  "
>
                  <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground"><MessageSquare size={13} />{message.senderRole} • {message.senderName}</p>
                  <p className="mt-1 text-sm text-muted whitespace-pre-line">{message.message}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted">{new Date(message.createdAt).toLocaleString()}</p>
                    {message.hasProofFile ? (
                      <a href={`/api/payments/messages/${message.id}/file`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand-700 hover:underline">
                        View proof
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <form className="mt-3 space-y-2" onSubmit={(event) => void sendReply(event, payment.id)}>
              <textarea
                rows={2}
                value={replyText[payment.id] ?? ""}
                onChange={(event) => setReplyText((prev) => ({ ...prev, [payment.id]: event.target.value }))}
                className="control-textarea"
                placeholder="Add a follow-up message"
              />
              <input
                type="file"
                accept=".pdf,image/png,image/jpeg,image/webp"
                onChange={(event) => setReplyFile((prev) => ({ ...prev, [payment.id]: event.target.files?.[0] ?? null }))}
                className="control-input"
              />
              <button type="submit" className="btn-secondary gap-2" disabled={isSaving}><Send size={14} />Send message</button>
              {replyFile[payment.id] ? (
                <p className="inline-flex items-center gap-1.5 text-xs text-muted"><Upload size={12} />Attached: {replyFile[payment.id]?.name}</p>
              ) : null}
            </form>
          </article>
        ))}
      </div>
    </section>
  );
}
