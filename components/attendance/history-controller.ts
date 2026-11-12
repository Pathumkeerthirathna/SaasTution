/*
 * Cursor-paged loading of attendance history (Stage 5.6c), framework-free:
 * the register's history (GET .../attendance/history) and one student's
 * history (GET .../students/[studentId]/history), through the shared typed
 * helpers of components/attendance/attendance-ui.ts.
 *
 *  - pages follow the server's keyset exactly: the first page has no cursor,
 *    every next page sends the previous page's nextCursor unchanged; no
 *    offsets; null nextCursor = the end;
 *  - page size 1–100 (default 50);
 *  - one page request at a time: loadMore() while a page is loading is
 *    refused; load() (first page / reload) aborts whatever is in flight and
 *    ignores its answer;
 *  - entries are kept in version order and never duplicated (the audit
 *    version is unique per register / record);
 *  - the pages are not one snapshot (history can grow between requests): the
 *    header fields (register version, record state, QR closure) come from the
 *    LATEST page received, and an entry added after a page was read simply
 *    arrives on a later page;
 *  - an error keeps everything already loaded (and the cursor, so
 *    loadMore() retries the same page); nothing retries automatically;
 *  - dispose() (unmount): aborts and ignores everything afterwards.
 */

import {
  fetchRegisterHistory,
  fetchStudentHistory,
  HISTORY_DEFAULT_PAGE_SIZE,
  HISTORY_MAX_PAGE_SIZE,
  type AttendanceApiError,
  type AttendanceApiResult,
  type HistoryPageRequest,
  type RegisterHistoryEntry,
  type RegisterHistoryResponse,
  type StudentHistoryEntry,
  type StudentHistoryResponse,
} from "@/components/attendance/attendance-ui";

type HistoryPage<E> = { entries: E[]; nextCursor: string | null };

export type HistoryState<P extends HistoryPage<E>, E extends { version: number }> = {
  /** Every entry loaded so far, ascending by version, without duplicates. */
  entries: E[];
  /** The latest page received (its header fields), or null before the first one. */
  latest: Omit<P, "entries" | "nextCursor"> | null;
  /** The server's cursor for the next page (exactly as given); null at the end or before the first page. */
  nextCursor: string | null;
  /** True once a page answered with nextCursor null. */
  complete: boolean;
  loading: "first" | "more" | null;
  /** The last failure (entries already loaded are kept). */
  error: AttendanceApiError | null;
};

export type HistoryLoaderDeps<P extends HistoryPage<E>, E extends { version: number }> = {
  fetchPage: (page: HistoryPageRequest, options: { signal: AbortSignal }) => Promise<AttendanceApiResult<P>>;
  onChange: (state: HistoryState<P, E>) => void;
  /** 1–100 (default 50). */
  pageSize?: number;
};

export function clampHistoryPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return HISTORY_DEFAULT_PAGE_SIZE;
  return Math.min(HISTORY_MAX_PAGE_SIZE, Math.max(1, Math.floor(value)));
}

/** Adds a page's entries: only versions not seen yet, kept ascending. */
export function mergeHistoryEntries<E extends { version: number }>(existing: readonly E[], incoming: readonly E[]): E[] {
  const seen = new Set(existing.map((entry) => entry.version));
  const added = incoming.filter((entry) => {
    if (seen.has(entry.version)) return false;
    seen.add(entry.version);
    return true;
  });
  if (added.length === 0) return [...existing];
  return [...existing, ...added].sort((a, b) => a.version - b.version);
}

export function createHistoryLoader<P extends HistoryPage<E>, E extends { version: number }>(deps: HistoryLoaderDeps<P, E>) {
  const limit = clampHistoryPageSize(deps.pageSize);
  let state: HistoryState<P, E> = { entries: [], latest: null, nextCursor: null, complete: false, loading: null, error: null };
  let requestId = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: HistoryState<P, E>) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };

  async function fetchInto(kind: "first" | "more", cursor: string | null): Promise<boolean> {
    inFlight?.abort();
    const abort = new AbortController();
    inFlight = abort;
    const id = ++requestId;
    set({ ...state, loading: kind, error: null });

    let result: AttendanceApiResult<P>;
    try {
      result = await deps.fetchPage({ cursor, limit }, { signal: abort.signal });
    } catch {
      result = { ok: false, status: 0, code: "INVALID_RESPONSE", message: "The server sent an unexpected response. Please try again." };
    }
    if (disposed || id !== requestId) return false;
    inFlight = null;

    if (!result.ok) {
      set({ ...state, loading: null, error: result });
      return false;
    }
    const { entries, nextCursor, ...header } = result.data;
    set({
      entries: mergeHistoryEntries(kind === "first" ? [] : state.entries, entries),
      latest: header as Omit<P, "entries" | "nextCursor">,
      nextCursor,
      complete: nextCursor === null,
      loading: null,
      error: null,
    });
    return true;
  }

  return {
    getState: () => state,

    /**
     * The first page (also a full reload): aborts and ignores any request in
     * flight. The entries already shown are replaced only when the new first
     * page arrives (a failed reload keeps them, with the error).
     */
    async load(): Promise<boolean> {
      if (disposed) return false;
      return fetchInto("first", null);
    },

    /**
     * The next page with the server's cursor. Refused (false) after dispose,
     * while a page is loading, before the first page, or at the end. After an
     * error it requests the same page again (manual retry).
     */
    async loadMore(): Promise<boolean> {
      if (disposed || state.loading !== null || state.complete || state.nextCursor === null) return false;
      return fetchInto("more", state.nextCursor);
    },

    /** Unmount: abort and ignore everything afterwards. */
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
    },
  };
}

export type HistoryLoader<P extends HistoryPage<E>, E extends { version: number }> = ReturnType<typeof createHistoryLoader<P, E>>;

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** The register's history (GET /api/lectures/[id]/attendance/history). */
export function createRegisterHistoryLoader(input: {
  lectureId: string;
  onChange: (state: HistoryState<RegisterHistoryResponse, RegisterHistoryEntry>) => void;
  pageSize?: number;
  fetchImpl?: FetchImpl;
}) {
  return createHistoryLoader<RegisterHistoryResponse, RegisterHistoryEntry>({
    fetchPage: (page, options) => fetchRegisterHistory(input.lectureId, page, { ...options, fetchImpl: input.fetchImpl }),
    onChange: input.onChange,
    pageSize: input.pageSize,
  });
}

/** One student's history (GET /api/lectures/[id]/attendance/students/[studentId]/history). */
export function createStudentHistoryLoader(input: {
  lectureId: string;
  studentId: string;
  onChange: (state: HistoryState<StudentHistoryResponse, StudentHistoryEntry>) => void;
  pageSize?: number;
  fetchImpl?: FetchImpl;
}) {
  return createHistoryLoader<StudentHistoryResponse, StudentHistoryEntry>({
    fetchPage: (page, options) => fetchStudentHistory(input.lectureId, input.studentId, page, { ...options, fetchImpl: input.fetchImpl }),
    onChange: input.onChange,
    pageSize: input.pageSize,
  });
}
