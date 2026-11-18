/**
 * QR attendance payment warning, Stage 2: the scanner's payment snapshot
 * (components/attendance/payment-snapshot.ts) and its wiring into the
 * scanner (components/attendance/qr-scanner-panel.tsx): one fetch of
 * GET /api/classes/[classId]/outstanding-students per class, a Set of real
 * Student.id values, loading / ready / failed, stale-response protection,
 * clearing, the non-blocking failure notice with Retry, and that scanning
 * never waits for it. Fakes only: no browser, no server, no database.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { AttendanceRegisterResponse } from "../../components/attendance/attendance-ui";
import {
  createPaymentSnapshot,
  fetchOutstandingStudents,
  IDLE_PAYMENT_SNAPSHOT,
  outstandingStudentsEndpoint,
  readOutstandingStudentIds,
  type OutstandingStudentsResult,
  type PaymentSnapshotState,
} from "../../components/attendance/payment-snapshot";
import { createScanQueue, type QrScanResponse, type ScanQueueSnapshot } from "../../components/attendance/qr-scanner-logic";
import { PAYMENT_STATUS_FAILED_MESSAGE, PaymentStatusNotice, ScannerView, type ScannerViewProps } from "../../components/attendance/qr-scanner-panel";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};
async function settle(times = 10) {
  for (let i = 0; i < times; i += 1) await tick();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const okIds = (studentIds: string[]): OutstandingStudentsResult => ({ ok: true, status: 200, data: { studentIds } });
const httpError = (status: number, code: string): OutstandingStudentsResult => ({ ok: false, status, code, message: "safe" });

/** A snapshot over a scripted fetch: every call is recorded with its own gate and signal. */
function harness() {
  const calls: { classId: string; signal: AbortSignal; gate: ReturnType<typeof deferred<OutstandingStudentsResult>> }[] = [];
  const states: PaymentSnapshotState[] = [];
  const snapshot = createPaymentSnapshot({
    onChange: (s) => states.push(s),
    fetchOutstanding: (classId, { signal }) => {
      const gate = deferred<OutstandingStudentsResult>();
      calls.push({ classId, signal, gate });
      return gate.promise;
    },
  });
  return { snapshot, calls, states, last: () => snapshot.current() };
}

const outstandingOf = (state: PaymentSnapshotState) => (state.status === "ready" ? [...state.outstanding].sort() : null);

// ---- Loading ------------------------------------------------------------------------------------

test("success: one fetch for the class; ready with a Set of the returned Student ids", async () => {
  const h = harness();
  assert.deepEqual(h.last(), IDLE_PAYMENT_SNAPSHOT);
  const done = h.snapshot.load("class-1");
  assert.equal(h.last().status, "loading");
  assert.equal(h.last().classId, "class-1");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].classId, "class-1", "the class id from the register");
  h.calls[0].gate.resolve(okIds(["stu-1", "stu-2"]));
  await done;
  const state = h.last();
  assert.equal(state.status, "ready");
  assert.ok(state.status === "ready" && state.outstanding instanceof Set);
  assert.deepEqual(outstandingOf(state), ["stu-1", "stu-2"]);
  assert.ok(state.status === "ready" && state.outstanding.has("stu-1") && !state.outstanding.has("stu-3"));
  assert.deepEqual(h.states.map((s) => s.status), ["loading", "ready"]);
});

test("request: GET /api/classes/[classId]/outstanding-students, same-origin, no-store, with the abort signal; the class id is encoded", async () => {
  assert.equal(outstandingStudentsEndpoint("class-1"), "/api/classes/class-1/outstanding-students");
  assert.equal(outstandingStudentsEndpoint("a/b?c"), "/api/classes/a%2Fb%3Fc/outstanding-students");
  const original = globalThis.fetch;
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ success: true, data: { studentIds: ["stu-9"] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const result = await fetchOutstandingStudents("class-1", { signal: controller.signal });
    assert.deepEqual(result, { ok: true, status: 200, data: { studentIds: ["stu-9"] } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/classes/class-1/outstanding-students");
    assert.equal(seen[0].init?.method, "GET");
    assert.equal(seen[0].init?.credentials, "same-origin");
    assert.equal(seen[0].init?.cache, "no-store");
    assert.equal(seen[0].init?.signal, controller.signal);
  } finally {
    globalThis.fetch = original;
  }
});

test("empty outstanding list: ready with an empty Set (not failed)", async () => {
  const h = harness();
  const done = h.snapshot.load("class-1");
  h.calls[0].gate.resolve(okIds([]));
  await done;
  assert.equal(h.last().status, "ready");
  assert.deepEqual(outstandingOf(h.last()), []);
});

test("failure: HTTP errors, no answer, a thrown fetch or an unexpected shape → failed, never an empty Set", async () => {
  const cases: (OutstandingStudentsResult | "throw")[] = [
    httpError(500, "INTERNAL_SERVER_ERROR"),
    httpError(404, "CLASS_NOT_FOUND"),
    httpError(401, "UNAUTHORIZED"),
    { ok: false, status: 0, code: "NETWORK_ERROR", message: "" },
    { ok: true, status: 200, data: {} as { studentIds: string[] } },
    { ok: true, status: 200, data: { studentIds: [1, 2] } as unknown as { studentIds: string[] } },
    { ok: true, status: 200, data: { studentIds: [""] } },
    "throw",
  ];
  for (const outcome of cases) {
    const states: PaymentSnapshotState[] = [];
    const snapshot = createPaymentSnapshot({
      onChange: (s) => states.push(s),
      fetchOutstanding: async () => {
        if (outcome === "throw") throw new Error("boom");
        return outcome;
      },
    });
    await snapshot.load("class-1");
    const state = snapshot.current();
    assert.equal(state.status, "failed", JSON.stringify(outcome));
    assert.equal(state.classId, "class-1");
    assert.ok(!("outstanding" in state), "no Set when failed");
  }
  assert.equal(readOutstandingStudentIds({ studentIds: ["a", "b"] })?.length, 2);
  assert.equal(readOutstandingStudentIds(null), null);
});

test("retry after failure: a fresh request for the same class; loading, then ready", async () => {
  const h = harness();
  const first = h.snapshot.load("class-1");
  h.calls[0].gate.resolve(httpError(503, "SERVICE_UNAVAILABLE"));
  await first;
  assert.equal(h.last().status, "failed");

  const again = h.snapshot.retry();
  assert.equal(h.calls.length, 2, "a new request, nothing reused");
  assert.equal(h.calls[1].classId, "class-1");
  assert.equal(h.last().status, "loading");
  h.calls[1].gate.resolve(okIds(["stu-5"]));
  await again;
  assert.deepEqual(outstandingOf(h.last()), ["stu-5"]);

  // A retry with no class does nothing.
  const idle = harness();
  await idle.snapshot.retry();
  assert.equal(idle.calls.length, 0);
});

// ---- Stale responses, class change and clearing --------------------------------------------------

test("class change: the old request is aborted and its late answer never overwrites the new class's snapshot", async () => {
  const h = harness();
  const a = h.snapshot.load("class-a");
  const b = h.snapshot.load("class-b");
  assert.equal(h.calls[0].signal.aborted, true, "class A's request aborted");
  assert.equal(h.calls[1].signal.aborted, false);
  assert.equal(h.last().classId, "class-b");
  h.calls[1].gate.resolve(okIds(["stu-b"]));
  await b;
  h.calls[0].gate.resolve(okIds(["stu-a"]));
  await a;
  assert.equal(h.last().classId, "class-b");
  assert.deepEqual(outstandingOf(h.last()), ["stu-b"]);
  assert.deepEqual(h.states.map((s) => `${s.status}:${s.classId}`), ["loading:class-a", "loading:class-b", "ready:class-b"]);
});

test("stale protection: an older request for the same class answering last is ignored (sequence counter)", async () => {
  const h = harness();
  const first = h.snapshot.load("class-1");
  const second = h.snapshot.retry();
  h.calls[1].gate.resolve(okIds(["fresh"]));
  await second;
  h.calls[0].gate.resolve(okIds(["stale"]));
  await first;
  assert.deepEqual(outstandingOf(h.last()), ["fresh"]);
  // ...also when the older one fails late.
  const third = h.snapshot.retry();
  const fourth = h.snapshot.retry();
  h.calls[3].gate.resolve(okIds(["newest"]));
  await fourth;
  h.calls[2].gate.resolve(httpError(500, "INTERNAL_SERVER_ERROR"));
  await third;
  assert.deepEqual(outstandingOf(h.last()), ["newest"]);
});

test("clear / dispose (scanner closed or class changed): the ids are dropped, the request aborted, late answers ignored", async () => {
  const h = harness();
  const done = h.snapshot.load("class-1");
  h.calls[0].gate.resolve(okIds(["stu-1"]));
  await done;
  h.snapshot.clear();
  assert.deepEqual(h.last(), IDLE_PAYMENT_SNAPSHOT);

  const pending = h.snapshot.load("class-1");
  h.snapshot.dispose();
  assert.equal(h.calls[1].signal.aborted, true);
  assert.deepEqual(h.last(), IDLE_PAYMENT_SNAPSHOT);
  const changes = h.states.length;
  h.calls[1].gate.resolve(okIds(["stu-late"]));
  await pending;
  assert.deepEqual(h.last(), IDLE_PAYMENT_SNAPSHOT, "nothing after dispose");
  assert.equal(h.states.length, changes, "no change reported after dispose");
  await h.snapshot.load("class-1");
  assert.equal(h.calls.length, 2, "a disposed snapshot never fetches again");
});

// ---- Attendance is independent -------------------------------------------------------------------

test("scanning continues while the snapshot is loading, and after it failed: scans are sent and answered", async () => {
  const scan: QrScanResponse = {
    result: "VALID",
    effect: "STATUS_UPDATED",
    replayed: false,
    receivedAt: "2026-09-01T12:35:07.000Z",
    afterFinalization: false,
    student: { studentId: "stu-77", name: "Amal Perera", registrationNumber: null },
    attendance: { status: "PRESENT", statusSource: "AUTO", pendingReview: false },
  };
  for (const outcome of ["loading", "failed"] as const) {
    const h = harness();
    void h.snapshot.load("class-1");
    if (outcome === "failed") {
      h.calls[0].gate.resolve(httpError(500, "INTERNAL_SERVER_ERROR"));
      await settle();
    }
    assert.equal(h.last().status, outcome);

    const answered: QrScanResponse[] = [];
    const snapshots: ScanQueueSnapshot[] = [];
    let ids = 0;
    const queue = createScanQueue({
      lectureId: "lec-1",
      onChange: (s) => snapshots.push(s),
      onAnswered: (o) => answered.push(o),
      newClientScanId: () => `client-scan-id-${String(++ids).padStart(4, "0")}`,
      submit: async () => ({ result: { ok: true, status: 200, data: scan }, retryAfterSeconds: null }),
    });
    assert.equal(queue.enqueue("SLCQR1:" + "A".repeat(43), "CAMERA"), "QUEUED");
    await settle();
    assert.equal(answered.length, 1, `answered while the snapshot is ${outcome}`);
    assert.equal(snapshots[snapshots.length - 1].pending.length, 0);
    assert.equal(h.calls.length, 1, "no payment request per scan");
    queue.dispose();
    h.snapshot.dispose();
  }
});

// ---- The view and the panel wiring ---------------------------------------------------------------

function registerFixture(): AttendanceRegisterResponse {
  return {
    lecture: { id: "lec-1", classId: "class-1", title: "Kinematics II", classStatus: "SCHEDULED", date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { lectureId: "lec-1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 1, finalized: false, finalizedAt: null },
    configuration: { approval: "OK", evidence: "OK" },
    classification: "LIVE",
    students: [],
    summary: { students: 30, withRecord: 12, recordStatus: { PRESENT: 9, LATE: 3, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 1 },
    absencePreview: null,
    onlineEvidence: null,
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: false, reason: "BEFORE_END" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN" },
  } as AttendanceRegisterResponse;
}

const viewProps = (patch: Partial<ScannerViewProps> = {}): ScannerViewProps => ({
  register: registerFixture(),
  availability: { available: true },
  refreshFailed: false,
  camera: { phase: "idle" },
  hint: null,
  manualValue: "",
  manualProblem: null,
  queue: { pending: [], feed: [], pausedUntil: null, signedOut: false },
  now: 0,
  announcement: "",
  leaveConfirm: false,
  onBack: noop,
  onStay: noop,
  onLeave: noop,
  onRefresh: noop,
  onStartCamera: noop,
  onStopCamera: noop,
  onManualChange: noop,
  onManualSubmit: noop,
  onRetry: noop,
  ...patch,
});

test("view: failed shows the non-blocking notice with Retry; loading, ready, idle and absent show nothing; scanning stays enabled", () => {
  const failed = renderToStaticMarkup(<ScannerView {...viewProps({ paymentStatus: "failed", onRetryPaymentStatus: noop })} />);
  assert.ok(text(failed).includes(PAYMENT_STATUS_FAILED_MESSAGE));
  assert.equal(PAYMENT_STATUS_FAILED_MESSAGE, "Payment status could not be loaded. Payment alerts are temporarily unavailable.");
  assert.match(failed, /<button type="button"[^>]*>(?:(?!<\/button>)[\s\S])*Retry<\/button>/);
  assert.match(failed, /role="status"[^>]*>(?:(?!role=)[\s\S])*Payment status could not be loaded/, "a status message, not an alert or dialog");
  const input = failed.match(/<input[^>]*id="qr-scanner-manual-input"[^>]*>/)?.[0] ?? "";
  assert.ok(input !== "" && !input.includes(' disabled=""'), "manual entry stays available");
  const buttons = [...failed.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 3 && buttons.every((b) => !b.includes(' disabled=""')), "Start camera, Send and Retry stay enabled");

  for (const status of ["loading", "ready", "idle", undefined] as const) {
    const html = renderToStaticMarkup(<ScannerView {...viewProps({ paymentStatus: status })} />);
    assert.ok(!text(html).includes("Payment status could not be loaded"), String(status));
  }
  assert.ok(text(renderToStaticMarkup(<PaymentStatusNotice />)).includes(PAYMENT_STATUS_FAILED_MESSAGE));
});

test("panel wiring: fetched per class from the register's classId, retried through the snapshot, cleared on class change / unmount, never touched by scanning", () => {
  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  assert.match(panel, /const classId = register\?\.lecture\.classId \?\? null;/);
  const effect = panel.slice(panel.indexOf("  useEffect(() => {\n    if (!classId) return;"), panel.indexOf("}, [classId]);") + "}, [classId]);".length);
  assert.ok(effect.length > 0 && effect.includes("}, [classId]);"), "one effect keyed on the class id");
  assert.match(effect, /createPaymentSnapshot\(\{ onChange: setPayment \}\)/);
  assert.match(effect, /void snapshot\.load\(classId\);/);
  const cleanup = effect.slice(effect.indexOf("return () => {"));
  for (const call of ["snapshot.dispose()", "paymentRef.current = null", "setPayment(IDLE_PAYMENT_SNAPSHOT)"]) assert.ok(cleanup.includes(call), call);
  assert.match(panel, /const retryPaymentStatus = useCallback\(\(\) => void paymentRef\.current\?\.retry\(\), \[\]\);/);
  assert.match(panel, /paymentStatus=\{payment\.status\}/);
  assert.match(panel, /onRetryPaymentStatus=\{retryPaymentStatus\}/);

  // The scan queue and its callbacks never load, retry or wait for the snapshot: they only read it
  // (Stage 3: the audio cue of a new mark), synchronously.
  const mount = panel.slice(panel.indexOf("  // ---- Queue, refresher, camera"), panel.indexOf("}, [lectureId, load, showHint]);"));
  assert.deepEqual(mount.match(/paymentRef\.[^\s,)]*/g), ["paymentRef.current?.current("], "one synchronous read");
  assert.doesNotMatch(mount, /\.load\(|\.retry\(|outstandingStudents|fetchOutstanding|await [^\n]*payment/i);
  const manual = panel.slice(panel.indexOf("const submitManual = useCallback"), panel.indexOf("const retry = useCallback"));
  assert.doesNotMatch(manual, /payment|outstanding/i);
  assert.equal((panel.match(/createPaymentSnapshot\(/g) ?? []).length, 1, "one snapshot per class, not per scan");
});

test("privacy and bundle: the snapshot module keeps ids in memory only, logs nothing, imports no server code", () => {
  const code = source("components", "attendance", "payment-snapshot.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./);
  assert.doesNotMatch(code, /console\./);
  assert.doesNotMatch(code, /@\/services\/|@\/lib\/prisma|server-only|fee-payment-state/);
});
