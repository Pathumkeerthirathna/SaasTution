/**
 * Online attendance evidence, dispatched AFTER the visit's own transaction
 * committed (services/session-service.ts markAttendanceOnJoin). See
 * docs/lecture-attendance.md ("Online evidence").
 *
 * The visit (Attendance row) is already committed when this runs, so nothing
 * here can fail, slow down or change the join: dispatchOnlineEvidence never
 * throws and returns at once. The evidence itself runs later, in its own
 * transaction (recordOnlineEvidence), through a small in-process queue:
 *  - at most ONLINE_EVIDENCE_CONCURRENCY transactions at once per process,
 *    so a class-start burst of joins never takes the database connections
 *    the joins themselves need;
 *  - at most ONLINE_EVIDENCE_QUEUE_CAPACITY waiting visits per process;
 *    overflow is dropped (logged);
 *  - errors are logged (sanitized) and dropped; no automatic retries.
 * Everything dropped, failed or lost (a process restart empties the queue) is
 * recoverable: the visit is committed, and reconciliation (Stage 5.4f)
 * re-derives the evidence from the committed visits.
 *
 * Not run at all:
 *  - on serverless platforms (Netlify, AWS Lambda): a background promise
 *    there can be frozen mid-transaction while holding row locks (D1);
 *  - when APPROVAL_FEATURE_STARTED_AT or ATTENDANCE_EVIDENCE_STARTED_AT is
 *    unavailable (fail closed).
 * Each process has its own queue; correctness never depends on there being
 * one process (all coordination is through database locks). No Redis or
 * other infrastructure. The queue is isolated here and replaceable.
 */

import {
  loadApprovalConfig,
  loadEvidenceConfig,
  warnConfigurationOnce,
  ATTENDANCE_EVIDENCE_STARTED_AT_SETTING,
} from "@/lib/attendance/config";
import { summarizeError } from "@/lib/error-logging/sanitize";
import { APPROVAL_FEATURE_STARTED_AT_SETTING } from "@/lib/student-confirmation-history";
import { recordOnlineEvidence } from "@/services/lecture-attendance-evidence-service";

export const ONLINE_EVIDENCE_CONCURRENCY = 2;
export const ONLINE_EVIDENCE_QUEUE_CAPACITY = 200;

type Env = Record<string, string | undefined>;
type Processor = (visitId: string) => Promise<unknown>;

type DispatcherState = {
  queue: string[];
  running: number;
  processor: Processor;
  dropped: number;
  failed: number;
  idleWaiters: (() => void)[];
  lastOverflowLogAt: number;
  serverlessWarned: boolean;
};

const holder = globalThis as unknown as { slAttendanceEvidenceDispatcher?: DispatcherState };

function freshState(): DispatcherState {
  return {
    queue: [],
    running: 0,
    processor: (visitId) => recordOnlineEvidence(visitId),
    dropped: 0,
    failed: 0,
    idleWaiters: [],
    lastOverflowLogAt: 0,
    serverlessWarned: false,
  };
}

function state(): DispatcherState {
  return (holder.slAttendanceEvidenceDispatcher ??= freshState());
}

/** Netlify / AWS Lambda: no background work (same rule as the teacher-departure sweeper). */
export function isServerlessRuntime(env: Env = process.env): boolean {
  return Boolean(env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Queues the canonical evidence of a committed visit. Never throws, never
 * awaits: the caller's response is unaffected whatever happens here.
 */
export function dispatchOnlineEvidence(visitId: string, env: Env = process.env): void {
  try {
    const s = state();

    if (isServerlessRuntime(env)) {
      if (!s.serverlessWarned) {
        s.serverlessWarned = true;
        console.warn("[attendance] online evidence is not dispatched on serverless platforms; reconciliation records it.");
      }
      return;
    }

    const approval = loadApprovalConfig(env).status;
    const evidence = loadEvidenceConfig(env).status;
    if (approval !== "OK" || evidence !== "OK") {
      warnConfigurationOnce(APPROVAL_FEATURE_STARTED_AT_SETTING, approval);
      warnConfigurationOnce(ATTENDANCE_EVIDENCE_STARTED_AT_SETTING, evidence);
      return;
    }

    if (typeof visitId !== "string" || visitId === "") return;

    if (s.queue.length >= ONLINE_EVIDENCE_QUEUE_CAPACITY) {
      s.dropped += 1;
      const now = Date.now();
      if (now - s.lastOverflowLogAt >= 60_000) {
        s.lastOverflowLogAt = now;
        console.warn(`[attendance] online evidence queue full; ${s.dropped} visit(s) left for reconciliation.`);
      }
      return;
    }

    s.queue.push(visitId);
    // Started on a later turn of the event loop: no evidence code runs
    // inside the join request's own call stack or before its continuation.
    setImmediate(() => pump(s));
  } catch (error) {
    // Never reaches the join.
    logFailure(error);
  }
}

function pump(s: DispatcherState) {
  while (s.running < ONLINE_EVIDENCE_CONCURRENCY && s.queue.length > 0) {
    const visitId = s.queue.shift() as string;
    s.running += 1;
    void run(s, visitId);
  }
}

async function run(s: DispatcherState, visitId: string) {
  try {
    await s.processor(visitId);
  } catch (error) {
    s.failed += 1;
    logFailure(error);
  } finally {
    s.running -= 1;
    pump(s);
    if (s.running === 0 && s.queue.length === 0) {
      const waiters = s.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}

function logFailure(error: unknown) {
  try {
    console.error(`[attendance] online evidence not recorded (reconciliation will retry): ${summarizeError(error)}`);
  } catch {
    // Logging must never throw either.
  }
}

/** TESTS ONLY. */
export const onlineEvidenceDispatcherForTesting = {
  reset(processor?: Processor) {
    holder.slAttendanceEvidenceDispatcher = freshState();
    if (processor) holder.slAttendanceEvidenceDispatcher.processor = processor;
  },
  snapshot() {
    const s = state();
    return { queued: s.queue.length, running: s.running, dropped: s.dropped, failed: s.failed };
  },
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    const s = state();
    if (s.running === 0 && s.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => s.idleWaiters.push(resolve));
  },
};
