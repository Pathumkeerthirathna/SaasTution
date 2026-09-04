"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Megaphone, ChevronLeft, ChevronRight } from "lucide-react";

import { useStudentLiveEvent } from "@/components/student-portal/use-student-live-events";
import type { PaginationMeta } from "@/lib/api-types";

type MessageItem = {
  id: string;
  classId: string;
  className: string;
  teacherName: string;
  content: string;
  sentAt: string;
};

type ClassOption = { id: string; name: string };

const LAST_SEEN_KEY = "student-messages-last-seen";
const PAGE_SIZE = 10;

function readLastSeen(): number {
  try {
    const value = localStorage.getItem(LAST_SEEN_KEY);
    return value ? new Date(value).getTime() : 0;
  } catch {
    return 0;
  }
}

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Windowed page list: 1 … 4 5 [6] 7 8 … 20 */
function pageItems(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | "gap")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) items.push("gap");
  for (let p = start; p <= end; p += 1) items.push(p);
  if (end < total - 1) items.push("gap");
  items.push(total);
  return items;
}

type MessagesResponse = {
  success?: boolean;
  data?: { messages?: MessageItem[]; classes?: ClassOption[] };
  pagination?: PaginationMeta;
};

async function fetchMessages(params: { page: number; classId: string }): Promise<MessagesResponse> {
  const qs = new URLSearchParams({ page: String(params.page), pageSize: String(PAGE_SIZE) });
  if (params.classId) qs.set("classId", params.classId);
  try {
    const res = await fetch(`/api/students/me/messages?${qs.toString()}`, { cache: "no-store" });
    return (await res.json()) as MessagesResponse;
  } catch {
    return {};
  }
}

export function StudentMessageBell() {
  const [open, setOpen] = useState(false);

  // Badge feed: newest announcements, unfiltered — drives the unread count.
  const [latest, setLatest] = useState<MessageItem[]>([]);
  const [lastSeen, setLastSeen] = useState(0);

  // Panel feed: the filtered + paginated view shown while the panel is open.
  const [items, setItems] = useState<MessageItem[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [classId, setClassId] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLastSeen(readLastSeen());
  }, []);

  const loadLatest = useCallback(async () => {
    const json = await fetchMessages({ page: 1, classId: "" });
    if (json.success && json.data?.messages) setLatest(json.data.messages);
  }, []);

  const loadPanel = useCallback(async (nextPage: number, nextClassId: string) => {
    setLoading(true);
    const json = await fetchMessages({ page: nextPage, classId: nextClassId });
    if (json.success && json.data) {
      setItems(json.data.messages ?? []);
      if (json.data.classes) setClasses(json.data.classes);
      setPagination(json.pagination ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // Realtime: a teacher sending a class message fires `counts-stale`.
  useStudentLiveEvent("counts-stale", () => {
    void loadLatest();
    if (open) void loadPanel(page, classId);
  });

  // Refetch the panel whenever the filter or page changes while open.
  useEffect(() => {
    if (open) void loadPanel(page, classId);
  }, [open, page, classId, loadPanel]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const unread = latest.filter((m) => new Date(m.sentAt).getTime() > lastSeen).length;

  function openPanel() {
    setOpen(true);
    // Mark the newest announcements as seen.
    if (latest.length > 0) {
      const newest = latest[0].sentAt;
      try {
        localStorage.setItem(LAST_SEEN_KEY, newest);
      } catch {
        /* private mode — the badge just won't persist */
      }
      setLastSeen(new Date(newest).getTime());
    }
  }

  function closePanel() {
    setOpen(false);
    // Reset the browse state so the next open starts from the newest, unfiltered.
    setClassId("");
    setPage(1);
  }

  function toggle() {
    if (open) closePanel();
    else openPanel();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        title="Announcements by teacher"
        aria-label="Announcements by teacher"
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border border-brand-200 bg-white text-slate-600 transition-all hover:border-brand-300 hover:bg-brand-50"
      >
        <Megaphone size={17} />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-2 flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-brand-100 px-4 py-2.5">
            <p className="text-sm font-bold text-foreground">Announcements</p>
            <Link
              href="/student/messages"
              onClick={closePanel}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              View all
            </Link>
          </div>

          {/* Class filter */}
          <div className="border-b border-brand-100 px-4 py-2">
            <label className="sr-only" htmlFor="announcement-class-filter">
              Filter by class
            </label>
            <select
              id="announcement-class-filter"
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-brand-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-400"
            >
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* List */}
          {loading && items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted">
              {classId ? "No announcements for this class." : "No announcements yet."}
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-brand-50 overflow-y-auto">
              {items.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/student/messages?focus=${m.id}`}
                    onClick={closePanel}
                    className="block px-4 py-3 transition-colors hover:bg-brand-50/60"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-semibold text-brand-700">{m.className}</p>
                      <span className="shrink-0 text-[10px] text-muted">{relativeTime(m.sentAt)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-foreground">{m.content}</p>
                    <p className="mt-1 text-[10px] text-muted">{m.teacherName}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 ? (
            <div className="flex flex-col gap-1.5 border-t border-brand-100 px-3 py-2">
              <p className="px-1 text-[10px] text-muted">
                {pagination.totalItems} announcement{pagination.totalItems !== 1 ? "s" : ""} · page{" "}
                {pagination.page} of {pagination.totalPages}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  disabled={!pagination.hasPreviousPage || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-brand-200 bg-white text-slate-600 hover:bg-brand-50 disabled:opacity-40"
                >
                  <ChevronLeft size={13} />
                </button>

                {pageItems(pagination.page, pagination.totalPages).map((it, idx) =>
                  it === "gap" ? (
                    <span key={`gap-${idx}`} className="px-0.5 text-xs text-slate-400">
                      …
                    </span>
                  ) : (
                    <button
                      key={it}
                      type="button"
                      disabled={loading}
                      aria-current={it === pagination.page ? "page" : undefined}
                      onClick={() => setPage(it)}
                      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-lg border px-1.5 text-xs transition-colors ${
                        it === pagination.page
                          ? "border-brand-600 bg-brand-600 font-semibold text-white"
                          : "border-brand-200 bg-white text-slate-700 hover:bg-brand-50"
                      }`}
                    >
                      {it}
                    </button>
                  )
                )}

                <button
                  type="button"
                  disabled={!pagination.hasNextPage || loading}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="Next page"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-brand-200 bg-white text-slate-600 hover:bg-brand-50 disabled:opacity-40"
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
