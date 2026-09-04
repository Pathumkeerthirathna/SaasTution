"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Panel } from "@/components/student-portal/student-ui";
import { focusElementId, useFocusHighlight } from "@/components/student-portal/use-focus-highlight";
import { useStudentLiveRefetch } from "@/components/student-portal/use-student-live-events";
import type { PaginationMeta } from "@/lib/api-types";

type ClassOption = { id: string; name: string };

type MessageItem = {
  id: string;
  messageId: string;
  classId: string;
  className: string;
  content: string;
  sentAt: string;
  status: string;
};

type PaperSupportMessageItem = {
  id: string;
  message: string;
  createdAt: string;
  classId: string;
  className: string;
  itemTitle: string;
  bundleTitle: string;
};

const PAGE_SIZE = 10;

/** Windowed page list: 1 … 4 5 [6] 7 8 … 20 */
function pageItems(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | "ellipsis")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) items.push("ellipsis");
  for (let p = start; p <= end; p += 1) items.push(p);
  if (end < total - 1) items.push("ellipsis");
  items.push(total);
  return items;
}

export default function StudentMessagesPage() {
  return (
    <Suspense fallback={null}>
      <StudentMessagesPageInner />
    </Suspense>
  );
}

function StudentMessagesPageInner() {
  const searchParams = useSearchParams();

  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [paperSupportMessages, setPaperSupportMessages] = useState<PaperSupportMessageItem[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState(() => searchParams.get("classId") ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [liveTick, setLiveTick] = useState(0);

  useFocusHighlight(!isLoading && messages.length > 0);

  // Realtime: refresh when a teacher sends a new class message / announcement.
  useStudentLiveRefetch(() => setLiveTick((n) => n + 1));

  function applyFilter(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(1);
    };
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (classId) params.set("classId", classId);
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));

        const res = await fetch(`/api/students/me/messages?${params.toString()}`);
        const supportRes = await fetch(`/api/students/me/paper-support-messages?page=1&pageSize=6&${params.toString()}`);
        const json = await res.json() as {
          success: boolean;
          data?: { messages: MessageItem[]; classes: ClassOption[] };
          pagination?: PaginationMeta;
          error?: { message: string };
        };
        const supportJson = await supportRes.json() as {
          success: boolean;
          data?: { messages: PaperSupportMessageItem[] };
        };

        if (!cancelled) {
          if (json.success && json.data) {
            setMessages(json.data.messages);
            setClasses(json.data.classes);
            setPagination(json.pagination ?? null);
            setPaperSupportMessages(supportJson.success ? (supportJson.data?.messages ?? []) : []);
          } else {
            setError(json.error?.message ?? "Failed to load messages.");
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load messages.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [classId, from, to, page, liveTick]);

  function clearFilters() {
    setClassId("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  const hasFilter = classId || from || to;

  return (
    <Panel title="Messages / Announcements" subtitle="Recent updates from teachers and classes.">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border-b border-brand-200 pb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">Class</label>
          <select
            value={classId}
            onChange={applyFilter(setClassId)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">From</label>
          <input
            type="date"
            value={from}
            onChange={applyFilter(setFrom)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">To</label>
          <input
            type="date"
            value={to}
            onChange={applyFilter(setTo)}
            className="rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        {hasFilter ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div id="paper-support" className="mt-6 scroll-mt-24 border-t border-brand-200 pt-4">
        <h3 className="text-sm font-semibold text-slate-900">Your paper late-reason messages</h3>
        {paperSupportMessages.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No late-reason messages found.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {paperSupportMessages.map((item) => (
              <article key={item.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    {item.className} • {item.bundleTitle}
                  </p>
                  <time className="text-xs text-slate-500">
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </div>
                <p className="mt-1 text-xs text-slate-600">Paper: {item.itemTitle}</p>
                <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{item.message}</p>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="mt-4">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-500">
            No messages found{hasFilter ? " for the selected filters" : ""}.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((item) => (
              <article
                key={item.id}
                id={focusElementId(item.id)}
                className="scroll-mt-24 rounded-xl border border-brand-200 bg-white p-3 transition-shadow"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {item.className}
                  </p>
                  <time className="text-xs text-slate-500">
                    {new Date(item.sentAt).toLocaleString()}
                  </time>
                </div>
                <p className="mt-2 text-sm text-slate-700 whitespace-pre-line">{item.content}</p>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Server-side pagination with page numbers */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex flex-col gap-3 border-t border-brand-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            {pagination.totalItems} message{pagination.totalItems !== 1 ? "s" : ""} · page{" "}
            {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={!pagination.hasPreviousPage || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg border border-brand-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-brand-50 disabled:opacity-40"
            >
              Prev
            </button>

            {pageItems(pagination.page, pagination.totalPages).map((item, idx) =>
              item === "ellipsis" ? (
                <span key={`gap-${idx}`} className="px-1 text-sm text-slate-400">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  disabled={isLoading}
                  aria-current={item === pagination.page ? "page" : undefined}
                  onClick={() => setPage(item)}
                  className={`min-w-[2rem] rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
                    item === pagination.page
                      ? "border-brand-600 bg-brand-600 font-semibold text-white"
                      : "border-brand-200 bg-white text-slate-700 hover:bg-brand-50"
                  }`}
                >
                  {item}
                </button>
              )
            )}

            <button
              type="button"
              disabled={!pagination.hasNextPage || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-brand-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-brand-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

