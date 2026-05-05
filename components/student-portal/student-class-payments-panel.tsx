"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type StudentClassLite = {
  id: string;
  name: string;
  monthlyFee: number;
  paymentDueWeek: number;
  teacherName: string;
};

type PaymentMessage = {
  id: string;
  senderRole: "STUDENT" | "TEACHER";
  senderName: string;
  message: string;
  hasProofFile: boolean;
  createdAt: string;
};

type PaymentItem = {
  id: string;
  classId: string;
  month: string;
  amount: number;
  note: string | null;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  teacherFeedback: string | null;
  hasSlip: boolean;
  submittedAt: string;
  messages: PaymentMessage[];
};

type Props = {
  classes: StudentClassLite[];
};

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getDueDateForMonth(monthKey: string, dueWeek: number) {
  const [year, month] = monthKey.split("-").map((item) => Number(item));
  const day = Math.min(Math.max(dueWeek, 1), 4) * 7;
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

function statusClass(status: PaymentItem["status"]) {
  if (status === "CONFIRMED") return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (status === "NEEDS_CLARIFICATION") return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-brand-50 text-brand-700 border border-brand-200";
}

export function StudentClassPaymentsPanel({ classes }: Props) {
  const [selectedClassId, setSelectedClassId] = useState(classes[0]?.id ?? "");
  const [month, setMonth] = useState(getCurrentMonthKey());
  const [amount, setAmount] = useState(String(classes[0]?.monthlyFee ?? 0));
  const [note, setNote] = useState("");
  const [slip, setSlip] = useState<File | null>(null);
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replyFile, setReplyFile] = useState<Record<string, File | null>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const selectedClass = useMemo(
    () => classes.find((item) => item.id === selectedClassId) ?? null,
    [classes, selectedClassId]
  );
  const selectedClassDueDate = useMemo(() => {
    if (!selectedClass) return null;
    return getDueDateForMonth(month, selectedClass.paymentDueWeek);
  }, [month, selectedClass]);

  useEffect(() => {
    if (selectedClass) {
      setAmount(String(selectedClass.monthlyFee));
    }
  }, [selectedClass]);

  async function loadPayments(classId: string) {
    if (!classId) {
      setPayments([]);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/student/payments?classId=${encodeURIComponent(classId)}`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: { payments: PaymentItem[] };
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to load payments.");
        return;
      }

      setPayments(payload.data?.payments ?? []);
    } catch {
      setErrorMessage("Unable to load payment history right now.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedClassId) return;
    void loadPayments(selectedClassId);
  }, [selectedClassId]);

  async function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedClassId) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const formData = new FormData();
      formData.set("classId", selectedClassId);
      formData.set("month", month);
      formData.set("amount", amount);
      formData.set("note", note);
      if (slip) formData.set("slip", slip);

      const response = await fetch(`/api/student/payments`, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as { success: boolean; error?: { message?: string } };
      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to submit payment.");
        return;
      }

      setSuccessMessage("Payment submitted successfully.");
      setNote("");
      setSlip(null);
      await loadPayments(selectedClassId);
    } catch {
      setErrorMessage("Unable to submit payment right now.");
    } finally {
      setIsSaving(false);
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>, paymentId: string) {
    event.preventDefault();
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

      const response = await fetch(`/api/student/payments/${paymentId}/messages`, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as { success: boolean; error?: { message?: string } };
      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Failed to send reply.");
        return;
      }

      setSuccessMessage("Reply sent.");
      setReplyText((prev) => ({ ...prev, [paymentId]: "" }));
      setReplyFile((prev) => ({ ...prev, [paymentId]: null }));
      await loadPayments(selectedClassId);
    } catch {
      setErrorMessage("Unable to send reply right now.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="panel-shell mt-6">
      <div>
        <h2 className="text-lg font-semibold">Class Payments</h2>
        <p className="text-sm text-muted">Submit monthly class payments and track teacher confirmations.</p>
      </div>

      <form className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={submitPayment}>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Class</label>
          <select value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)} className="control-select" required>
            {classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} (Fee: Rs {item.monthlyFee.toLocaleString()})
                {` · Due week ${item.paymentDueWeek}`}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Month</label>
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="control-input" required />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Amount (LKR)</label>
          <input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} className="control-input" required />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Payment slip (optional)</label>
          <input type="file" accept=".pdf,image/png,image/jpeg,image/webp" onChange={(event) => setSlip(event.target.files?.[0] ?? null)} className="control-input" />
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Message (optional)</label>
          <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} className="control-textarea" placeholder="Any payment note for teacher" />
        </div>

        <div className="md:col-span-2">
          <button type="submit" className="btn-primary" disabled={isSaving}>Submit payment</button>
        </div>
      </form>

      {selectedClass ? (
        <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
          <p className="font-medium text-brand-700">Selected class fee: Rs {selectedClass.monthlyFee.toLocaleString()}</p>
          <p className="mt-0.5 text-xs text-muted">Payment due week: Week {selectedClass.paymentDueWeek}</p>
          {selectedClassDueDate ? <p className="mt-0.5 text-xs text-muted">Due date for {month}: {selectedClassDueDate.toLocaleDateString()}</p> : null}
        </div>
      ) : null}
      {errorMessage ? <p className="notice-error mt-4">{errorMessage}</p> : null}
      {successMessage ? <p className="notice-success mt-4">{successMessage}</p> : null}

      {isLoading ? <p className="mt-5 text-sm text-muted">Loading payment history...</p> : null}
      {!isLoading && payments.length === 0 ? <p className="mt-5 text-sm text-muted">No payment submissions yet.</p> : null}

      <div className="mt-5 space-y-4">
        {payments.map((payment) => (
          <article key={payment.id} className="surface-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{payment.month}</p>
                <p className="mt-0.5 text-xs text-muted">Submitted: {new Date(payment.submittedAt).toLocaleString()}</p>
                <p className="mt-1 text-sm font-medium text-brand-700">Amount: Rs {payment.amount.toLocaleString()}</p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(payment.status)}`}>{payment.status.replaceAll("_", " ")}</span>
            </div>

            {payment.note ? <p className="mt-2 text-sm text-muted">{payment.note}</p> : null}
            {payment.hasSlip ? (
              <a href={`/api/payments/${payment.id}/slip`} target="_blank" rel="noreferrer" className="btn-ghost mt-3 text-xs">
                View submitted slip
              </a>
            ) : null}

            {payment.teacherFeedback ? <p className="notice-error mt-3">Teacher feedback: {payment.teacherFeedback}</p> : null}

            <div className="mt-3 space-y-2">
              {payment.messages.map((message) => (
                <div key={message.id} className="surface-soft px-3 py-2">
                  <p className="text-xs font-semibold text-foreground">{message.senderRole} • {message.senderName}</p>
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
                className="control-textarea"
                placeholder="Reply with a message"
                value={replyText[payment.id] ?? ""}
                onChange={(event) => setReplyText((prev) => ({ ...prev, [payment.id]: event.target.value }))}
              />
              <input
                type="file"
                accept=".pdf,image/png,image/jpeg,image/webp"
                className="control-input"
                onChange={(event) => setReplyFile((prev) => ({ ...prev, [payment.id]: event.target.files?.[0] ?? null }))}
              />
              <button type="submit" className="btn-secondary" disabled={isSaving}>Send reply</button>
            </form>
          </article>
        ))}
      </div>
    </section>
  );
}
