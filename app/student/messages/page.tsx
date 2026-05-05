"use client";

import { useEffect, useState } from "react";

import { Panel } from "@/components/student-portal/student-ui";
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

export default function StudentMessagesPage() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [paperSupportMessages, setPaperSupportMessages] = useState<PaperSupportMessageItem[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

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
  }, [classId, from, to, page]);

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

      <div className="mt-6 border-t border-brand-200 pt-4">
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
              <article key={item.id} className="rounded-xl border border-brand-200 bg-white p-3">
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

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 ? (
        <div className="mt-5 flex items-center justify-between border-t border-brand-200 pt-4">
          <p className="text-xs text-slate-500">
            Page {pagination.page} of {pagination.totalPages} &mdash;{" "}
            {pagination.totalItems} message{pagination.totalItems !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!pagination.hasPreviousPage || isLoading}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!pagination.hasNextPage || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

