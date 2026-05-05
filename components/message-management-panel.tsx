"use client";

import { useEffect, useMemo, useState } from "react";

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

const PAGE_SIZE = 5;
const OPTION_PAGE_SIZE = 50;

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
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [viaEmail, setViaEmail] = useState(false);
  const [viaWhatsApp, setViaWhatsApp] = useState(false);
  const [paperSupportMessages, setPaperSupportMessages] = useState<PaperSupportMessageItem[]>([]);

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

  async function loadMessages(
    classId: string,
    nextPage = 1,
    filters?: { dateFrom?: string; dateTo?: string }
  ) {
    if (!classId) {
      setMessages([]);
      setPage(1);
      setTotalPages(1);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const activeDateFrom = filters?.dateFrom ?? historyDateFrom;
      const activeDateTo = filters?.dateTo ?? historyDateTo;

      const query = new URLSearchParams({
        classId,
        page: String(nextPage),
        pageSize: String(PAGE_SIZE),
      });

      if (activeDateFrom) {
        query.set("dateFrom", activeDateFrom);
      }

      if (activeDateTo) {
        query.set("dateTo", activeDateTo);
      }

      const response = await fetch(`/api/messages?${query.toString()}`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: MessageItem[];
        error?: ApiError;
        pagination?: {
          page: number;
          totalPages: number;
        };
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
  }

  async function loadPaperSupportMessages(classId?: string, filters?: { dateFrom?: string; dateTo?: string }) {
    try {
      const activeDateFrom = filters?.dateFrom ?? historyDateFrom;
      const activeDateTo = filters?.dateTo ?? historyDateTo;

      const query = new URLSearchParams({
        page: "1",
        pageSize: "6",
      });

      if (classId) query.set("classId", classId);
      if (activeDateFrom) query.set("from", activeDateFrom);
      if (activeDateTo) query.set("to", activeDateTo);

      const response = await fetch(`/api/paper-support-messages?${query.toString()}`);
      const payload = (await response.json()) as {
        success: boolean;
        data?: { messages: PaperSupportMessageItem[] };
      };

      if (!response.ok || !payload.success) {
        return;
      }

      setPaperSupportMessages(payload.data?.messages ?? []);
    } catch {
      // Keep announcement UX unaffected if support message query fails.
    }
  }

  useEffect(() => {
    async function bootstrap() {
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
        setErrorMessage(error instanceof Error ? error.message : "Failed to initialize messaging module.");
      } finally {
        setIsLoading(false);
      }
    }

    void bootstrap();
  }, []);

  type BulkPayload = {
    success: boolean;
    error?: ApiError;
    data?: {
      delivery: { provider: string; delivered: number; failed: number; queued: number };
      totalRecipients: number;
      whatsappUrl?: string;
    };
  };

  async function sendChannel(channel: "email" | "whatsapp"): Promise<BulkPayload> {
    const response = await fetch("/api/messages/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId: selectedClassId, content, channel }),
    });
    return (await response.json()) as BulkPayload;
  }

  async function handleSend() {
    if (!selectedClassId || !content.trim()) return;
    if (!viaEmail && !viaWhatsApp) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    // Open WhatsApp immediately — must be synchronous before any await
    // to avoid browsers blocking the popup.
    if (viaWhatsApp) {
      window.open(
        `https://wa.me/?text=${encodeURIComponent(content)}`,
        "_blank",
        "noopener,noreferrer"
      );
    }

    try {
      const parts: string[] = [];

      if (viaEmail) {
        const payload = await sendChannel("email");
        if (!payload.success || !payload.data) {
          setErrorMessage(payload.error?.message ?? "Failed to send email.");
          return;
        }
        const { delivered, failed } = payload.data.delivery;
        parts.push(
          `Email: sent to ${delivered} student${delivered === 1 ? "" : "s"}${failed > 0 ? `, ${failed} skipped (no email on file)` : ""}`
        );
      }

      if (viaWhatsApp) {
        // Save to DB in background — WhatsApp is already open
        const payload = await sendChannel("whatsapp");
        if (!payload.success || !payload.data) {
          setErrorMessage(payload.error?.message ?? "Failed to save WhatsApp message record.");
          return;
        }
        parts.push(`WhatsApp: opened with message`);
      }

      setSuccessMessage(parts.join(" · "));
      setContent("");
      await loadMessages(selectedClassId, 1);
      await loadPaperSupportMessages(selectedClassId);
    } catch {
      setErrorMessage("Unable to send message right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
    <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1.9fr]">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Send class message</h2>
            <p className="mt-1 text-sm text-muted">
              Broadcast announcements to all students in a selected class.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsHelpOpen(true)}
            className="shrink-0 rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            Help
          </button>
        </div>

        <form className="mt-4 space-y-4" onSubmit={(e) => e.preventDefault()}>
          <div>
            <label htmlFor="messageClass" className="mb-1 block text-sm font-medium">
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
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
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
            <label htmlFor="messageContent" className="mb-1 block text-sm font-medium">
              Message content
            </label>
            <textarea
              id="messageContent"
              required
              rows={6}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
              placeholder="Write announcement, homework reminder, or class update"
            />
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Send via</p>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/15 px-4 py-3 transition hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.04]">
                <input
                  type="checkbox"
                  checked={viaEmail}
                  onChange={(e) => setViaEmail(e.target.checked)}
                  className="h-4 w-4 accent-foreground"
                />
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Email</p>
                  <p className="text-xs text-muted">Sends directly to each student's email address</p>
                </div>
              </label>

              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/15 px-4 py-3 transition hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.04]">
                <input
                  type="checkbox"
                  checked={viaWhatsApp}
                  onChange={(e) => setViaWhatsApp(e.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0 text-emerald-500" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">WhatsApp</p>
                  <p className="text-xs text-muted">Opens WhatsApp — pick contacts or groups to send to</p>
                </div>
              </label>
            </div>

            {(viaEmail || viaWhatsApp) && (
              <button
                type="button"
                disabled={isSubmitting || !selectedClassId || !content.trim()}
                onClick={() => void handleSend()}
                className="mt-3 w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Sending..." : "Send to all students"}
              </button>
            )}
          </div>
        </form>

        {successMessage ? (
          <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {successMessage}
          </p>
        ) : null}
      </article>

      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">Message history</h2>
          <p className="text-sm text-muted">
            {selectedClass ? selectedClass.name : "No class selected"} • Page {page} of {totalPages}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
          <div>
            <label htmlFor="historyDateFrom" className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
              From date
            </label>
            <input
              id="historyDateFrom"
              type="date"
              value={historyDateFrom}
              onChange={(event) => setHistoryDateFrom(event.target.value)}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            />
          </div>
          <div>
            <label htmlFor="historyDateTo" className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
              To date
            </label>
            <input
              id="historyDateTo"
              type="date"
              value={historyDateTo}
              onChange={(event) => setHistoryDateTo(event.target.value)}
              className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none transition focus:border-black/40 dark:border-white/20 dark:bg-transparent"
            />
          </div>
          <button
            type="button"
            disabled={isLoading || !selectedClassId}
            onClick={() => {
              void loadMessages(selectedClassId, 1);
              void loadPaperSupportMessages(selectedClassId);
            }}
            className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            Apply
          </button>
          <button
            type="button"
            disabled={isLoading || !selectedClassId}
            onClick={() => {
              setHistoryDateFrom("");
              setHistoryDateTo("");
              void loadMessages(selectedClassId, 1, { dateFrom: "", dateTo: "" });
              void loadPaperSupportMessages(selectedClassId, { dateFrom: "", dateTo: "" });
            }}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20"
          >
            Clear
          </button>
        </div>

        {errorMessage ? (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </p>
        ) : null}

        {isLoading ? <p className="mt-4 text-sm text-muted">Loading messages...</p> : null}

        {!isLoading && messages.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No messages found for this class yet.</p>
        ) : null}

        <div className="mt-5 space-y-3">
          {messages.map((item) => (
            <div key={item.id} className="rounded-2xl border border-black/10 p-4 dark:border-white/10">
              <p className="whitespace-pre-wrap text-sm">{item.content}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <span className="rounded-lg bg-black/[0.04] px-2 py-1 text-muted dark:bg-white/[0.06]">
                  Total: {item.deliverySummary.total}
                </span>
                <span className="rounded-lg bg-amber-100 px-2 py-1 text-amber-800">
                  Queued: {item.deliverySummary.queued}
                </span>
                <span className="rounded-lg bg-emerald-100 px-2 py-1 text-emerald-800">
                  Sent: {item.deliverySummary.sent}
                </span>
                <span className="rounded-lg bg-red-100 px-2 py-1 text-red-700">
                  Failed: {item.deliverySummary.failed}
                </span>
              </div>
              <p className="mt-3 text-xs text-muted">
                Sent on {new Date(item.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={isLoading || page <= 1 || !selectedClassId}
            onClick={() => void loadMessages(selectedClassId, page - 1)}
            className="rounded-xl border border-black/15 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/20"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={isLoading || page >= totalPages || !selectedClassId}
            onClick={() => void loadMessages(selectedClassId, page + 1)}
            className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            Next
          </button>
        </div>

        <div className="mt-8 border-t border-black/10 pt-5 dark:border-white/10">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Paper late-reason messages</h3>
            <p className="text-xs text-muted">Latest 6</p>
          </div>

          {paperSupportMessages.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No student late-reason messages found for current filters.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {paperSupportMessages.map((item) => (
                <article key={item.id} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      {item.studentName}
                      {item.registrationNumber ? ` (${item.registrationNumber})` : ""}
                    </p>
                    <time className="text-xs text-slate-600">{new Date(item.createdAt).toLocaleString()}</time>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">{item.className} • {item.bundleTitle} • {item.itemTitle}</p>
                  <p className="mt-1 text-sm text-slate-700 whitespace-pre-line">{item.message}</p>
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
                <p className="mt-1 text-muted">Select a class and write a message to broadcast it to all enrolled students at once. Useful for homework reminders, schedule changes, and class updates.</p>
              </div>
              <div>
                <h3 className="font-semibold">Track Message History</h3>
                <p className="mt-1 text-muted">View all past messages sent to a class with delivery status per student — including how many were sent, queued, or failed.</p>
              </div>
              <div>
                <h3 className="font-semibold">Delivery Status</h3>
                <p className="mt-1 text-muted">Each message shows a breakdown of delivery results: total recipients, queued, sent, and failed counts. Future integrations like WhatsApp will appear here automatically.</p>
              </div>
              <div className="border-t border-black/10 pt-4 dark:border-white/10">
                <h3 className="font-semibold">How to Use</h3>
                <ol className="mt-2 list-inside list-decimal space-y-1 text-muted">
                  <li>Select the target class from the dropdown</li>
                  <li>Write your announcement in the message box</li>
                  <li>Click "Send to all students" to broadcast</li>
                  <li>Check the delivery summary that appears after sending</li>
                  <li>Use the message history panel on the right to review past messages</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

