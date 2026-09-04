"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ClassItem = {
  id: string;
  name: string;
  schedule: string;
};

type MessageItem = {
  id: string;
  classId: string;
  content: string;
  createdAt: string;
  deliverySummary: {
    total: number;
    queued: number;
    sent: number;
    failed: number;
  };
};

type ApiError = {
  message?: string;
};

type PaperSupportMessageItem = {
  id: string;
  message: string;
  createdAt: string;
  className: string;
  studentName: string;
  registrationNumber: string | null;
  itemTitle: string;
  bundleTitle: string;
};

type BulkPayload = {
  success: boolean;
  error?: ApiError;
  data?: {
    message: { id: string; classId: string; content: string; createdAt: string };
    recipientCount: number;
    email: { sent: number; failed: number } | null;
    whatsapp: { url: string; recipientCount: number } | null;
  };
};

type Period = "all" | "week" | "month" | "quarter" | "year";

const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
];

const PAGE_SIZE = 5;
const OPTION_PAGE_SIZE = 50;

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function periodToDateRange(period: Period): { dateFrom: string; dateTo: string } {
  if (period === "all") return { dateFrom: "", dateTo: "" };
  const now = new Date();
  const y = now.getFullYear();

  if (period === "week") {
    const start = new Date(y, now.getMonth(), now.getDate() - now.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { dateFrom: ymd(start), dateTo: ymd(end) };
  }
  if (period === "month") {
    return {
      dateFrom: ymd(new Date(y, now.getMonth(), 1)),
      dateTo: ymd(new Date(y, now.getMonth() + 1, 0)),
    };
  }
  if (period === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    return { dateFrom: ymd(new Date(y, q * 3, 1)), dateTo: ymd(new Date(y, q * 3 + 3, 0)) };
  }
  return { dateFrom: ymd(new Date(y, 0, 1)), dateTo: ymd(new Date(y, 11, 31)) };
}

export function MessageManagementPanel() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [content, setContent] = useState("");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [historyPeriod, setHistoryPeriod] = useState<Period>("all");
  const [viaEmail, setViaEmail] = useState(false);
  const [viaWhatsApp, setViaWhatsApp] = useState(false);
  const [paperSupportMessages, setPaperSupportMessages] = useState<PaperSupportMessageItem[]>([]);
  const [whatsappFallbackUrl, setWhatsappFallbackUrl] = useState<string | null>(null);
  const [lastSentContent, setLastSentContent] = useState("");
  const [copied, setCopied] = useState(false);

  const selectedClass = useMemo(
    () => classes.find((item) => item.id === selectedClassId) ?? null,
    [classes, selectedClassId]
  );

  async function loadClasses() {
    const response = await fetch(`/api/classes?page=1&pageSize=${OPTION_PAGE_SIZE}`);
    const payload = (await response.json()) as {
      success: boolean;
      data?: ClassItem[];
      error?: ApiError;
    };

    if (!response.ok || !payload.success) {
      throw new Error(payload.error?.message ?? "Failed to load classes.");
    }

    return payload.data ?? [];
  }

  const loadMessages = useCallback(
    async (classId: string, nextPage = 1) => {
      if (!classId) {
        setMessages([]);
        setPage(1);
        setTotalPages(1);
        return;
      }

      setIsLoading(true);
      setErrorMessage(null);

      try {
        const { dateFrom, dateTo } = periodToDateRange(historyPeriod);
        const query = new URLSearchParams({
          classId,
          page: String(nextPage),
          pageSize: String(PAGE_SIZE),
        });
        if (dateFrom) query.set("dateFrom", dateFrom);
        if (dateTo) query.set("dateTo", dateTo);

        const response = await fetch(`/api/messages?${query.toString()}`);
        const payload = (await response.json()) as {
          success: boolean;
          data?: MessageItem[];
          error?: ApiError;
          pagination?: { page: number; totalPages: number };
        };

        if (!response.ok || !payload.success) {
          setErrorMessage(payload.error?.message ?? "Failed to load message history.");
          return;
        }

        setMessages(payload.data ?? []);
        setPage(payload.pagination?.page ?? nextPage);
        setTotalPages(payload.pagination?.totalPages ?? 1);
      } catch {
        setErrorMessage("Unable to load message history right now.");
      } finally {
        setIsLoading(false);
      }
    },
    [historyPeriod]
  );

  const loadPaperSupportMessages = useCallback(
    async (classId?: string) => {
      try {
        const { dateFrom, dateTo } = periodToDateRange(historyPeriod);
        const query = new URLSearchParams({ page: "1", pageSize: "6" });
        if (classId) query.set("classId", classId);
        if (dateFrom) query.set("from", dateFrom);
        if (dateTo) query.set("to", dateTo);

        const response = await fetch(`/api/paper-support-messages?${query.toString()}`);
        const payload = (await response.json()) as {
          success: boolean;
          data?: { messages: PaperSupportMessageItem[] };
        };

        if (!response.ok || !payload.success) return;
        setPaperSupportMessages(payload.data?.messages ?? []);
      } catch {
        // Keep announcement UX unaffected if support message query fails.
      }
    },
    [historyPeriod]
  );

  const bootstrappedRef = useRef(false);

  useEffect(() => {
    async function run() {
      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        setIsLoading(true);
        setErrorMessage(null);
        try {
          const classList = await loadClasses();
          setClasses(classList);
          if (classList.length > 0) {
            setSelectedClassId(classList[0].id);
            await loadMessages(classList[0].id, 1);
            await loadPaperSupportMessages(classList[0].id);
          }
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to initialize messaging module."
          );
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // History period changed — refresh the current class's view only.
      if (selectedClassId) {
        await loadMessages(selectedClassId, 1);
        await loadPaperSupportMessages(selectedClassId);
      }
    }

    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyPeriod]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleSend() {
    if (!selectedClassId || !content.trim()) return;

    const channels: ("email" | "whatsapp")[] = [];
    if (viaEmail) channels.push("email");
    if (viaWhatsApp) channels.push("whatsapp");
    // No channel selected → in-app-only announcement (still saved + pushed via SSE).

    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    setWhatsappFallbackUrl(null);

    const outgoing = content.trim();

    // The WhatsApp tab must be opened synchronously in the click's call stack
    // or the browser blocks the popup. (`window.open` with `noopener` returns
    // null even on success, so we don't rely on its return value — the fallback
    // link in the success notice always covers a blocked popup.)
    if (viaWhatsApp) {
      window.open(
        `https://wa.me/?text=${encodeURIComponent(outgoing)}`,
        "_blank",
        "noopener,noreferrer"
      );
    }

    try {
      const response = await fetch("/api/messages/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId: selectedClassId, content: outgoing, channels }),
      });

      const raw = await response.text();
      let payload: BulkPayload | null = null;
      try {
        payload = raw ? (JSON.parse(raw) as BulkPayload) : null;
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.success || !payload.data) {
        setErrorMessage(
          payload?.error?.message ?? "Message could not be sent (server error). Please try again."
        );
        return;
      }

      const data = payload.data;
      const parts: string[] = [`Posted to ${data.recipientCount} student${data.recipientCount === 1 ? "" : "s"} in the app`];
      if (data.email) {
        parts.push(
          `Email: ${data.email.sent} sent${data.email.failed > 0 ? `, ${data.email.failed} skipped` : ""}`
        );
      }
      if (data.whatsapp) {
        parts.push("WhatsApp: opened");
        setWhatsappFallbackUrl(data.whatsapp.url);
      }

      setSuccessMessage(parts.join(" · "));
      setLastSentContent(outgoing);
      setContent("");
      await loadMessages(selectedClassId, 1);
      await loadPaperSupportMessages(selectedClassId);
    } catch {
      setErrorMessage("Message could not be sent — network error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const canSend = Boolean(selectedClassId) && content.trim().length > 0;

  return (
    <>
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_1.9fr]">
        <article className="panel-shell">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">Send class message</h2>
              <p className="mt-0.5 text-xs text-muted">
                Broadcast an announcement to every student in a class.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="btn-ghost shrink-0 px-2.5 py-1 text-xs"
            >
              Help
            </button>
          </div>

          <form className="mt-3 space-y-3" onSubmit={(e) => e.preventDefault()}>
            <div>
              <label htmlFor="messageClass" className="mb-1 block text-xs font-medium">
                Target class
              </label>
              <select
                id="messageClass"
                required
                value={selectedClassId}
                onChange={(event) => {
                  const nextClassId = event.target.value;
                  setSelectedClassId(nextClassId);
                  void loadMessages(nextClassId, 1);
                  void loadPaperSupportMessages(nextClassId);
                }}
                className="control-select"
              >
                <option value="">Select class</option>
                {classes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.schedule})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="messageContent" className="mb-1 block text-xs font-medium">
                Message content
              </label>
              <textarea
                id="messageContent"
                required
                rows={5}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                className="control-textarea"
                placeholder="Write an announcement, homework reminder, or class update"
              />
            </div>

            <div>
              <p className="mb-0.5 text-xs font-medium">Send via</p>
              <p className="mb-1.5 text-[11px] text-muted">
                Every message is posted in the student app. Add a channel to also push it out.
              </p>
              <div className="space-y-1.5">
                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-black/15 px-3 py-2 text-sm transition hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.04]">
                  <input
                    type="checkbox"
                    checked={viaEmail}
                    onChange={(e) => setViaEmail(e.target.checked)}
                    className="h-4 w-4 accent-foreground"
                  />
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">Email</p>
                    <p className="text-[11px] text-muted">Delivered to each student&apos;s email address</p>
                  </div>
                </label>

                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-black/15 px-3 py-2 text-sm transition hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.04]">
                  <input
                    type="checkbox"
                    checked={viaWhatsApp}
                    onChange={(e) => setViaWhatsApp(e.target.checked)}
                    className="h-4 w-4 accent-emerald-500"
                  />
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0 text-emerald-500" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">WhatsApp</p>
                    <p className="text-[11px] text-muted">Opens WhatsApp with the text ready to forward</p>
                  </div>
                </label>
              </div>

              <button
                type="button"
                disabled={isSubmitting || !canSend}
                onClick={() => void handleSend()}
                className="btn-primary mt-3 w-full"
              >
                {isSubmitting ? "Sending…" : "Send to all students"}
              </button>
            </div>
          </form>

          {successMessage ? (
            <div className="notice-success mt-3 space-y-2 text-sm">
              <p>{successMessage}</p>
              {whatsappFallbackUrl ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={whatsappFallbackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-ghost px-2.5 py-1 text-xs"
                  >
                    Open WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(lastSentContent);
                      setCopied(true);
                    }}
                    className="btn-ghost px-2.5 py-1 text-xs"
                  >
                    {copied ? "Copied" : "Copy message"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </article>

        <article className="panel-shell">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-base font-semibold">Message history</h2>
            <p className="text-xs text-muted">
              {selectedClass ? selectedClass.name : "No class selected"} • Page {page} of {totalPages}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {PERIODS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={isLoading}
                onClick={() => setHistoryPeriod(option.value)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  historyPeriod === option.value
                    ? "bg-emerald-600 text-white"
                    : "border border-black/15 bg-transparent text-muted hover:bg-black/[0.04] dark:border-white/20 dark:hover:bg-white/[0.06]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {errorMessage ? <p className="notice-error mt-3">{errorMessage}</p> : null}

          {isLoading ? <p className="mt-3 text-sm text-muted">Loading messages…</p> : null}

          {!isLoading && messages.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No messages found for this class in this period.</p>
          ) : null}

          <div className="mt-4 space-y-2.5">
            {messages.map((item) => (
              <div key={item.id} className="surface-card p-3">
                <p className="whitespace-pre-wrap text-sm">{item.content}</p>
                <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
                  <span className="rounded-md bg-black/[0.04] px-2 py-0.5 text-muted dark:bg-white/[0.06]">
                    Total {item.deliverySummary.total}
                  </span>
                  <span className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800">
                    Queued {item.deliverySummary.queued}
                  </span>
                  <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-emerald-800">
                    Sent {item.deliverySummary.sent}
                  </span>
                  <span className="rounded-md bg-red-100 px-2 py-0.5 text-red-700">
                    Failed {item.deliverySummary.failed}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  Sent {new Date(item.createdAt).toLocaleString()}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={isLoading || page <= 1 || !selectedClassId}
              onClick={() => void loadMessages(selectedClassId, page - 1)}
              className="btn-ghost"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={isLoading || page >= totalPages || !selectedClassId}
              onClick={() => void loadMessages(selectedClassId, page + 1)}
              className="btn-primary"
            >
              Next
            </button>
          </div>

          <div className="mt-7 border-t border-black/10 pt-4 dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Paper late-reason messages</h3>
              <p className="text-[11px] text-muted">Latest 6</p>
            </div>

            {paperSupportMessages.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No student late-reason messages for this period.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {paperSupportMessages.map((item) => (
                  <article key={item.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {item.studentName}
                        {item.registrationNumber ? ` (${item.registrationNumber})` : ""}
                      </p>
                      <time className="text-[11px] text-slate-600">
                        {new Date(item.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-600">
                      {item.className} • {item.bundleTitle} • {item.itemTitle}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{item.message}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </article>
      </section>

      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-card p-4 shadow-2xl dark:border-white/10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Class Messaging</h2>
              <button
                onClick={() => setIsHelpOpen(false)}
                className="inline-flex rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
              >
                Close
              </button>
            </div>
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="font-semibold">Send Announcements</h3>
                <p className="mt-1 text-muted">Select a class, write a message, and choose Email and/or WhatsApp. Email is delivered to every student with an address on file; WhatsApp opens a share window with the text so you can forward it to your class contacts or group.</p>
              </div>
              <div>
                <h3 className="font-semibold">Message history</h3>
                <p className="mt-1 text-muted">Every message is saved with a per-student delivery breakdown — total, queued, sent, and failed. Filter by This week / month / quarter / year.</p>
              </div>
              <div>
                <h3 className="font-semibold">Students see it instantly</h3>
                <p className="mt-1 text-muted">A saved message appears in the student&apos;s in-app notification bell in real time, and in their Messages page.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
