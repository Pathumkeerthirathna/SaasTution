"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Wallet,
  UserRound,
  CalendarClock,
  FileText,
  UploadCloud,
  CheckCircle2,
  Clock,
  AlertTriangle,
  X,
  ExternalLink,
} from "lucide-react";

import { focusElementId, useFocusHighlight } from "@/components/student-portal/use-focus-highlight";
import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";

type PaymentState = "UNPAID" | "ACTION_NEEDED" | "IN_REVIEW" | "PAID";

type PaymentInfo = {
  id: string;
  amount: number;
  status: "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
  note: string | null;
  teacherFeedback: string | null;
  hasSlip: boolean;
  slipFileName: string | null;
  submittedAt: string;
  confirmedAt: string | null;
};

type FeeItem = {
  feeId: string;
  classId: string;
  className: string;
  teacherName: string;
  year: number;
  month: number;
  dueDate: string | null;
  amount: number;
  discount: number;
  lateJoinDeduct: number;
  waiverAmount: number;
  finalAmount: number;
  state: PaymentState;
  payment: PaymentInfo | null;
};

type ClassOption = { id: string; name: string };
type Data = { toPay: FeeItem[]; inReview: FeeItem[]; paid: FeeItem[]; classes: ClassOption[] };

type SectionKey = "toPay" | "inReview" | "paid";
const SECTION_LABELS: Record<SectionKey, string> = {
  toPay: "To pay",
  inReview: "Awaiting confirmation",
  paid: "Paid",
};
function isSectionKey(value: string | null): value is SectionKey {
  return value === "toPay" || value === "inReview" || value === "paid";
}

const rs = (n: number) => `Rs ${n.toLocaleString()}`;

function monthLabel(year: number, month: number) {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function StudentPaymentsClient() {
  const searchParams = useSearchParams();

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [sectionFilter, setSectionFilter] = useState<SectionKey | null>(() => {
    const f = searchParams.get("filter");
    return isSectionKey(f) ? f : null;
  });
  const [data, setData] = useState<Data | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [submitFee, setSubmitFee] = useState<FeeItem | null>(null);
  const [note, setNote] = useState("");
  const [slip, setSlip] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async (cls: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const qs = cls ? `?classId=${encodeURIComponent(cls)}` : "";
      const res = await fetch(`/api/student/payments${qs}`, { cache: "no-store" });
      const json = (await res.json()) as { success: boolean; data?: Data; error?: { message?: string } };
      if (!res.ok || !json.success || !json.data) throw new Error(json.error?.message ?? "Failed to load payments.");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payments.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(classId);
  }, [classId, load]);

  // Realtime: refresh dues whenever a fee is assigned or a payment is submitted/confirmed.
  useStudentLiveRefetch(() => void load(classId));

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const classOptions = data?.classes ?? [];
  const isEmpty =
    !isLoading &&
    !error &&
    data != null &&
    data.toPay.length === 0 &&
    data.inReview.length === 0 &&
    data.paid.length === 0;

  function openSubmit(fee: FeeItem) {
    setSubmitFee(fee);
    setNote(fee.payment?.note ?? "");
    setSlip(null);
    setSubmitError(null);
  }

  function closeSubmit() {
    if (submitting) return;
    setSubmitFee(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submitFee) return;
    if (!slip) {
      setSubmitError("Choose a payment slip file (PDF, PNG, JPG or WEBP).");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.set("feeId", submitFee.feeId);
      fd.set("note", note.trim());
      fd.set("slip", slip);

      const res = await fetch("/api/student/payments", { method: "POST", body: fd });
      const json = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!res.ok || !json.success) {
        setSubmitError(json.error?.message ?? "Failed to submit payment slip.");
        return;
      }
      setSubmitFee(null);
      setToast("Payment slip submitted.");
      await load(classId);
    } catch {
      setSubmitError("Unable to submit right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const sections = useMemo(
    () => [
      {
        key: "toPay",
        title: "To pay",
        hint: "Ordered by due date",
        items: data?.toPay ?? [],
        icon: <CalendarClock size={13} />,
        tone: "text-amber-700",
      },
      {
        key: "inReview",
        title: "Awaiting confirmation",
        hint: "Submitted — waiting for your teacher",
        items: data?.inReview ?? [],
        icon: <Clock size={13} />,
        tone: "text-sky-700",
      },
      {
        key: "paid",
        title: "Paid",
        hint: "Confirmed by your teacher",
        items: data?.paid ?? [],
        icon: <CheckCircle2 size={13} />,
        tone: "text-emerald-700",
      },
    ],
    [data]
  );

  const visibleSections = sectionFilter
    ? sections.filter((s) => s.key === sectionFilter)
    : sections;

  useFocusHighlight(!isLoading && data != null);

  return (
    <>
      {/* Filter */}
      <div className="mb-3 flex flex-wrap items-end gap-2.5">
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold text-slate-500">Class</label>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
          >
            <option value="">All classes</option>
            {classOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {sectionFilter ? (
          <button
            type="button"
            onClick={() => setSectionFilter(null)}
            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
          >
            {SECTION_LABELS[sectionFilter]} only
            <X size={12} />
          </button>
        ) : null}
        {classId ? (
          <button
            type="button"
            onClick={() => setClassId("")}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Reset
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      ) : null}

      {isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : isEmpty ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
          No fees have been assigned to you yet.
        </div>
      ) : (
        <div className="space-y-5">
          {visibleSections.every((s) => s.items.length === 0) ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-6 text-center text-xs text-slate-600">
              {sectionFilter
                ? `Nothing in "${SECTION_LABELS[sectionFilter]}" right now.`
                : "No fees match the current filters."}
            </div>
          ) : null}
          {visibleSections.map((section) =>
            section.items.length === 0 ? null : (
              <div key={section.key}>
                <div className="mb-2 flex items-center gap-1.5">
                  <span className={section.tone}>{section.icon}</span>
                  <h2 className="text-xs font-bold uppercase tracking-wide text-slate-700">{section.title}</h2>
                  <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-bold text-slate-500">
                    {section.items.length}
                  </span>
                  <span className="text-[11px] text-slate-400">· {section.hint}</span>
                </div>
                <div className="space-y-2.5">
                  {section.items.map((fee) => (
                    <PaymentCard key={fee.feeId} fee={fee} onSubmit={() => openSubmit(fee)} />
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* Submit modal */}
      {submitFee ? (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={closeSubmit}
            className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px]"
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <form
              onSubmit={handleSubmit}
              className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                    {submitFee.payment ? "Re-submit slip" : "Submit payment slip"}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">
                    {submitFee.className} · {monthLabel(submitFee.year, submitFee.month)}
                  </p>
                  <p className="text-xs text-slate-500">Amount due: {rs(submitFee.finalAmount)}</p>
                </div>
                <button
                  type="button"
                  onClick={closeSubmit}
                  className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="space-y-3 px-4 py-3">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-slate-500">
                    Payment slip <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="file"
                    accept=".pdf,image/png,image/jpeg,image/webp"
                    onChange={(e) => setSlip(e.target.files?.[0] ?? null)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 file:mr-2 file:rounded-md file:border-0 file:bg-emerald-600 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white hover:file:bg-emerald-700"
                  />
                  {slip ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {slip.name} · {(slip.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-400">PDF, PNG, JPG or WEBP · max 10 MB</p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-slate-500">
                    Note <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Reference number, bank, or a message for your teacher"
                    className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-emerald-400"
                  />
                </div>

                {submitFee.payment?.teacherFeedback ? (
                  <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                    Teacher: {submitFee.payment.teacherFeedback}
                  </p>
                ) : null}

                {submitError ? (
                  <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{submitError}</p>
                ) : null}
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={closeSubmit}
                  disabled={submitting}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <UploadCloud size={13} />
                  {submitting ? "Submitting…" : "Submit slip"}
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}

      {toast ? (
        <div className="fixed bottom-4 right-4 z-[60] rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 shadow-lg">
          {toast}
        </div>
      ) : null}
    </>
  );
}

function StateBadge({ state }: { state: PaymentState }) {
  const map: Record<PaymentState, { label: string; cls: string; icon: ReactNode }> = {
    UNPAID: {
      label: "To pay",
      cls: "bg-amber-100 text-amber-700",
      icon: <CalendarClock size={10} />,
    },
    ACTION_NEEDED: {
      label: "Needs clarification",
      cls: "bg-rose-100 text-rose-700",
      icon: <AlertTriangle size={10} />,
    },
    IN_REVIEW: {
      label: "Awaiting confirmation",
      cls: "bg-sky-100 text-sky-700",
      icon: <Clock size={10} />,
    },
    PAID: {
      label: "Paid",
      cls: "bg-emerald-100 text-emerald-700",
      icon: <CheckCircle2 size={10} />,
    },
  };
  const s = map[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.cls}`}
    >
      {s.icon}
      {s.label}
    </span>
  );
}

function AdjustRow({ label, value, negative }: { label: string; value: number; negative?: boolean }) {
  if (value === 0) return null;
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className={negative ? "text-rose-600" : "text-slate-700"}>
        {negative ? "− " : ""}
        {rs(value)}
      </span>
    </div>
  );
}

function PaymentCard({ fee, onSubmit }: { fee: FeeItem; onSubmit: () => void }) {
  const paid = fee.state === "PAID";
  const p = fee.payment;

  return (
    <article
      id={focusElementId(fee.feeId)}
      className={`scroll-mt-24 rounded-lg border bg-white p-3 transition-shadow ${
        fee.state === "ACTION_NEEDED"
          ? "border-rose-200"
          : paid
            ? "border-emerald-200"
            : "border-slate-200"
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 break-words sm:truncate">
            {fee.className}
            <span className="ml-1.5 font-normal text-slate-400">· {monthLabel(fee.year, fee.month)}</span>
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <UserRound size={11} />
              {fee.teacherName}
            </span>
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={11} />
              Due {fmtDate(fee.dueDate)}
            </span>
          </p>
        </div>
        <StateBadge state={fee.state} />
      </div>

      {/* Fee breakdown */}
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <div className="rounded-md border border-slate-100 bg-slate-50/70 p-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-slate-500">Base amount</span>
            <span className="text-slate-700">{rs(fee.amount)}</span>
          </div>
          <AdjustRow label="Discount" value={fee.discount} negative />
          <AdjustRow label="Late-join deduction" value={fee.lateJoinDeduct} negative />
          <AdjustRow label="Waiver" value={fee.waiverAmount} negative />
          <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1 text-xs font-bold text-slate-900">
            <span>Final amount</span>
            <span className="text-emerald-700">{rs(fee.finalAmount)}</span>
          </div>
        </div>

        <div className="rounded-md border border-slate-100 bg-slate-50/70 p-2 text-[11px]">
          {p ? (
            <div className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Submitted</span>
                <span className="text-slate-700">{fmtDateTime(p.submittedAt)}</span>
              </div>
              {p.confirmedAt ? (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Confirmed</span>
                  <span className="text-emerald-700">{fmtDateTime(p.confirmedAt)}</span>
                </div>
              ) : null}
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Paid amount</span>
                <span className="text-slate-700">{rs(p.amount)}</span>
              </div>
              {p.hasSlip ? (
                <a
                  href={`/api/payments/${p.id}/slip`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-semibold text-emerald-700 hover:underline"
                >
                  <FileText size={11} />
                  {p.slipFileName ?? "View slip"}
                  <ExternalLink size={10} />
                </a>
              ) : null}
            </div>
          ) : (
            <p className="flex h-full items-center justify-center text-center text-slate-400">
              No slip submitted yet
            </p>
          )}
        </div>
      </div>

      {p?.note ? (
        <p className="mt-2 text-[11px] text-slate-500">
          <span className="font-semibold text-slate-600">Your note: </span>
          {p.note}
        </p>
      ) : null}

      {p?.teacherFeedback && fee.state !== "PAID" ? (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <span className="font-semibold">Teacher feedback: </span>
          {p.teacherFeedback}
        </p>
      ) : null}

      {!paid ? (
        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            onClick={onSubmit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            {p ? <UploadCloud size={13} /> : <Wallet size={13} />}
            {p ? "Re-submit slip" : "Submit payment slip"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
