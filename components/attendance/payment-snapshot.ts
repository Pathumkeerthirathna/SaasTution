/*
 * QR attendance payment warning (Stage 2): the scanner's payment snapshot.
 * Framework-free, tested without a DOM; qr-scanner-panel.tsx owns one per
 * class while the scanner is open.
 *
 *   GET /api/classes/[classId]/outstanding-students  → { studentIds }
 *
 * Fetched once when the scanner knows the lecture's class (on opening the
 * scanner, on a class change, or on Retry), never per scan. The ids are the
 * real Student.id values the API returns (the same id as a scan answer's
 * student.studentId), kept in memory only as a Set.
 *
 * States: idle (no class), loading, ready (the Set), failed. A failure is
 * never an empty Set: nothing may be assumed paid while the status is not
 * ready. Each load aborts the previous request and only the newest request
 * for the current class may change the state (sequence counter + class
 * check), so an older answer never overwrites a newer snapshot. clear() /
 * dispose() drop the ids. Nothing here touches the scan queue: attendance
 * never waits for, or fails because of, the snapshot.
 */

import { attendanceRequest, type AttendanceApiResult } from "@/components/attendance/attendance-ui";

export const outstandingStudentsEndpoint = (classId: string) => `/api/classes/${encodeURIComponent(classId)}/outstanding-students`;

export type PaymentSnapshotState =
  | { status: "idle"; classId: null }
  | { status: "loading"; classId: string }
  | { status: "ready"; classId: string; outstanding: ReadonlySet<string> }
  | { status: "failed"; classId: string };

export const IDLE_PAYMENT_SNAPSHOT: PaymentSnapshotState = { status: "idle", classId: null };

export type OutstandingStudentsResult = AttendanceApiResult<{ studentIds: string[] }>;

export type PaymentSnapshotDeps = {
  onChange: (state: PaymentSnapshotState) => void;
  /** Injectable for tests; the API through attendanceRequest (same-origin, no-store) by default. */
  fetchOutstanding?: (classId: string, options: { signal: AbortSignal }) => Promise<OutstandingStudentsResult>;
};

/** Reads the API's data: an array of non-empty string ids, or null (an unexpected shape is a failure). */
export function readOutstandingStudentIds(data: unknown): string[] | null {
  if (!data || typeof data !== "object") return null;
  const ids = (data as { studentIds?: unknown }).studentIds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id !== "")) return null;
  return ids as string[];
}

export function fetchOutstandingStudents(classId: string, options: { signal: AbortSignal }): Promise<OutstandingStudentsResult> {
  return attendanceRequest<{ studentIds: string[] }>(outstandingStudentsEndpoint(classId), { signal: options.signal });
}

export function createPaymentSnapshot(deps: PaymentSnapshotDeps) {
  const fetchOutstanding = deps.fetchOutstanding ?? fetchOutstandingStudents;
  let state: PaymentSnapshotState = IDLE_PAYMENT_SNAPSHOT;
  let seq = 0;
  let controller: AbortController | null = null;
  let disposed = false;

  const set = (next: PaymentSnapshotState) => {
    state = next;
    deps.onChange(next);
  };
  const abort = () => {
    seq += 1;
    controller?.abort();
    controller = null;
  };

  async function load(classId: string): Promise<void> {
    if (disposed || !classId) return;
    abort();
    const mine = seq;
    const own = new AbortController();
    controller = own;
    set({ status: "loading", classId });

    let result: OutstandingStudentsResult;
    try {
      result = await fetchOutstanding(classId, { signal: own.signal });
    } catch {
      result = { ok: false, status: 0, code: "NETWORK_ERROR", message: "" };
    }
    // Only the newest request, for the class still shown, may change the state.
    if (disposed || mine !== seq || state.classId !== classId) return;
    controller = null;
    const ids = result.ok ? readOutstandingStudentIds(result.data) : null;
    set(ids ? { status: "ready", classId, outstanding: new Set(ids) } : { status: "failed", classId });
  }

  return {
    /** A fresh snapshot for this class (aborts any request still running). */
    load,
    /** Retry: a fresh snapshot for the current class. */
    retry(): Promise<void> {
      return state.classId ? load(state.classId) : Promise.resolve();
    },
    current: (): PaymentSnapshotState => state,
    /** Drops the ids and any request still running. */
    clear() {
      if (disposed) return;
      abort();
      if (state.status !== "idle") set(IDLE_PAYMENT_SNAPSHOT);
    },
    /** clear(), then nothing changes any more. */
    dispose() {
      if (disposed) return;
      abort();
      state = IDLE_PAYMENT_SNAPSHOT;
      disposed = true;
    },
  };
}

export type PaymentSnapshot = ReturnType<typeof createPaymentSnapshot>;
