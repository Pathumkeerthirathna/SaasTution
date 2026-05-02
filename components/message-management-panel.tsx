"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

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

const PAGE_SIZE = 8;
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

  async function loadMessages(classId: string, nextPage = 1) {
    if (!classId) {
      setMessages([]);
      setPage(1);
      setTotalPages(1);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const query = new URLSearchParams({
        classId,
        page: String(nextPage),
        pageSize: String(PAGE_SIZE),
      });

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
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to initialize messaging module.");
      } finally {
        setIsLoading(false);
      }
    }

    void bootstrap();
  }, []);

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/messages/bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          classId: selectedClassId,
          content,
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: ApiError;
        data?: {
          delivery: {
            provider: string;
            delivered: number;
            failed: number;
            queued: number;
          };
          totalRecipients: number;
        };
      };

      if (!response.ok || !payload.success || !payload.data) {
        setErrorMessage(payload.error?.message ?? "Failed to send message.");
        return;
      }

      setSuccessMessage(
        `Message sent via ${payload.data.delivery.provider}. Sent: ${payload.data.delivery.delivered}, Failed: ${payload.data.delivery.failed}, Queued: ${payload.data.delivery.queued}, Total: ${payload.data.totalRecipients}.`
      );
      setContent("");
      await loadMessages(selectedClassId, 1);
    } catch {
      setErrorMessage("Unable to send message right now.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1.9fr]">
      <article className="rounded-3xl border border-black/10 bg-card p-5 shadow-sm dark:border-white/10 sm:p-6">
        <h2 className="text-lg font-semibold">Send class message</h2>
        <p className="mt-1 text-sm text-muted">
          Broadcast announcements to all students in a selected class.
        </p>

        <form className="mt-4 space-y-4" onSubmit={handleSendMessage}>
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

          <button
            type="submit"
            disabled={isSubmitting || !selectedClassId}
            className="w-full rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Sending..." : "Send to all students"}
          </button>
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
      </article>
    </section>
  );
}
