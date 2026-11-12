/**
 * Stage 5.7b-3d: the teacher's physical QR scanner — the route
 * (app/dashboard/attendance/[lectureId]/scan), the register entry
 * (components/attendance/qr-scan-entry.tsx), the pure logic
 * (qr-scanner-logic.ts: availability, payload checks, the request, the
 * sequential queue, outcome text, debounced refresh), the camera
 * (qr-camera.ts) and the views (qr-scanner-panel.tsx, rendered with
 * react-dom/server). Everything runs on fakes: a fake fetch with real
 * Response objects, a fake getUserMedia / tracks, fake timers. No browser,
 * no camera, no server, no database. Real-device camera testing is a
 * separate, manual step (pending).
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { AttendanceApiError, AttendanceRegisterResponse } from "../../components/attendance/attendance-ui";
import {
  checkScanPayload,
  createDebouncedRefresh,
  createScanQueue,
  describeScanError,
  describeScanOutcome,
  parseRetryAfter,
  payloadProblemMessage,
  QR_PAYLOAD_MAX_LENGTH,
  readScanResponse,
  registerPath,
  scannerAvailability,
  scannerPath,
  scanEndpoint,
  scanErrorRetryable,
  SCAN_QUEUE_LIMITS,
  submitQrScan,
  type QrScanResponse,
  type ScanQueueSnapshot,
  type ScanSubmitOutcome,
} from "../../components/attendance/qr-scanner-logic";
import {
  CAMERA_CONSTRAINTS,
  cameraErrorMessage,
  cameraSupport,
  classifyCameraError,
  createCameraController,
  createFrameScanner,
  decodeSize,
  FALLBACK_CAMERA_CONSTRAINTS,
  type CameraState,
  type StreamLike,
} from "../../components/attendance/qr-camera";
import {
  announcementFor,
  CameraSection,
  ManualEntryForm,
  QueueStatus,
  ResultsFeed,
  ScannerErrorView,
  ScannerView,
  type ScannerViewProps,
} from "../../components/attendance/qr-scanner-panel";
import { QrScanEntry } from "../../components/attendance/qr-scan-entry";
import { isNavItemActive } from "../../components/dashboard-shell";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};

const PAYLOAD = "SLCQR1:" + "A".repeat(43); // 50 characters, like a real student QR
const OTHER = "SLCQR1:" + "B".repeat(43);
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// ======================================================================================
// Fixtures
// ======================================================================================

function registerFixture(patch: {
  classStatus?: string;
  classification?: "LIVE" | "HISTORICAL" | null;
  approval?: string;
  evidence?: string;
  qr?: Partial<AttendanceRegisterResponse["qr"]> | null;
} = {}): AttendanceRegisterResponse {
  const base: AttendanceRegisterResponse = {
    lecture: { id: "lec-1", classId: "class-1", title: "Kinematics II", classStatus: patch.classStatus ?? "SCHEDULED", date: "2026-09-01T12:30:00.000Z", endDate: null },
    register: { lectureId: "lec-1", exists: true, scheduledStartAt: "2026-09-01T12:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 1, finalized: false, finalizedAt: null },
    configuration: { approval: patch.approval ?? "OK", evidence: patch.evidence ?? "OK" },
    classification: patch.classification === undefined ? "LIVE" : patch.classification,
    students: [],
    summary: { students: 30, withRecord: 12, recordStatus: { PRESENT: 9, LATE: 3, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 1 },
    absencePreview: null,
    onlineEvidence: null,
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: false, reason: "BEFORE_END" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-09-01T12:00:00.000Z", window: "OPEN", ...(patch.qr ?? {}) },
  };
  if (patch.qr === null) delete (base as Partial<AttendanceRegisterResponse>).qr;
  return base;
}

function scanResponse(patch: Partial<QrScanResponse> = {}): QrScanResponse {
  return {
    result: "VALID",
    effect: "STATUS_UPDATED",
    replayed: false,
    receivedAt: "2026-09-01T12:35:07.000Z",
    afterFinalization: false,
    student: { studentId: "stu-77", name: "Amal Perera", registrationNumber: "REG-0042" },
    attendance: { status: "PRESENT", statusSource: "AUTO", pendingReview: false },
    ...patch,
  };
}

const ok = (data: QrScanResponse = scanResponse()): ScanSubmitOutcome => ({ result: { ok: true, status: 200, data }, retryAfterSeconds: null });
const fail = (status: number, code: string, extra: { details?: unknown; retryAfterSeconds?: number | null } = {}): ScanSubmitOutcome => ({
  result: { ok: false, status, code, message: "safe message", ...(extra.details !== undefined ? { details: extra.details } : {}) },
  retryAfterSeconds: extra.retryAfterSeconds ?? null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A queue over a scripted submit; records every call (lecture, body). */
function queueHarness(options: { responses?: ScanSubmitOutcome[]; submit?: (body: { clientScanId: string; payload: string }) => Promise<ScanSubmitOutcome>; now?: () => number } = {}) {
  const calls: { lectureId: string; clientScanId: string; payload: string }[] = [];
  const sleeps: number[] = [];
  const snapshots: ScanQueueSnapshot[] = [];
  const events: string[] = [];
  let ids = 0;
  const responses = options.responses ? options.responses.slice() : [];
  const queue = createScanQueue({
    lectureId: "lec-1",
    onChange: (s) => snapshots.push(s),
    onEvent: (e) => events.push(e.kind),
    newClientScanId: () => `client-scan-id-${String(++ids).padStart(4, "0")}`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: options.now,
    submit: async (lectureId, body) => {
      calls.push({ lectureId, ...body });
      if (options.submit) return options.submit(body);
      const next = responses.shift();
      if (!next) throw new Error("no scripted response");
      return next;
    },
  });
  const last = () => snapshots[snapshots.length - 1];
  return { queue, calls, sleeps, snapshots, events, last };
}

async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await tick();
}

// ======================================================================================
// 1. Route, navigation and authorization
// ======================================================================================

test("route: /dashboard/attendance/[lectureId]/scan loads the client scanner; the middleware and sidebar cover it", () => {
  const page = source("app", "dashboard", "attendance", "[lectureId]", "scan", "page.tsx");
  assert.match(page, /import\("@\/components\/attendance\/qr-scanner-panel"\)\.then\(\(mod\) => mod\.QrScannerPanel\)/);
  assert.match(page, /<QrScannerPanel lectureId=\{params\.lectureId\} \/>/);
  assert.doesNotMatch(page, /"use client"/, "a server page; the panel is the client part");
  assert.match(source("middleware.ts"), /"\/dashboard\/:path\*"/, "the dashboard middleware (teacher session) covers the scanner");
  assert.equal(isNavItemActive("/dashboard/attendance/lec-1/scan", "/dashboard/attendance"), true, "Attendance stays active");
  assert.equal(scannerPath("lec 1/x"), "/dashboard/attendance/lec%201%2Fx/scan");
  assert.equal(registerPath("lec-1"), "/dashboard/attendance/lec-1");
  assert.equal(scanEndpoint("lec-1"), "/api/lectures/lec-1/attendance/qr/scans");
});

test("authorization: the panel loads the register through the API (404 / 401 shown, never decided locally)", () => {
  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  assert.match(panel, /fetchAttendanceRegister\(lectureId\)/);
  assert.doesNotMatch(panel, /teacherId|document\.cookie|getSession|role ===/, "no client-side authorization");
  const notFound = text(renderToStaticMarkup(<ScannerErrorView error={{ ok: false, status: 404, code: "LECTURE_NOT_FOUND", message: "server text" }} registerHref="/dashboard/attendance/x" onRetry={noop} />));
  assert.ok(notFound.includes("Lecture not found") && notFound.includes("not one of your lectures"));
  assert.ok(!notFound.includes("server text"));
  assert.ok(!notFound.includes("Try again"), "no retry for a 404");
  const signedOut = renderToStaticMarkup(<ScannerErrorView error={{ ok: false, status: 401, code: "UNAUTHORIZED", message: "Your session has expired." }} registerHref="/dashboard/attendance/x" onRetry={noop} />);
  assert.ok(signedOut.includes('href="/login"') && text(signedOut).includes("Please sign in again"));
  const network = text(renderToStaticMarkup(<ScannerErrorView error={{ ok: false, status: 0, code: "NETWORK_ERROR", message: "Could not reach the server." }} registerHref="/dashboard/attendance/x" onRetry={noop} />));
  assert.ok(network.includes("Try again") && network.includes("Back to the register"));
});

// ======================================================================================
// 2. QR window state and the register entry
// ======================================================================================

test("availability: only OPEN for an eligible lecture; every other state has its own reason and message", () => {
  assert.deepEqual(scannerAvailability(registerFixture()), { available: true });

  const notOpen = scannerAvailability(registerFixture({ qr: { window: "NOT_OPEN" } }));
  assert.equal(notOpen.available, false);
  if (!notOpen.available) {
    assert.equal(notOpen.reason, "NOT_OPEN");
    assert.equal(notOpen.opensAt, "2026-09-01T12:00:00.000Z");
    assert.match(notOpen.message, /opens at 1 Sept 2026, 17:30/);
  }

  const cases: [Parameters<typeof registerFixture>[0], string][] = [
    [{ qr: { window: "CLOSED", closed: true, closedAt: "2026-09-01T13:00:00.000Z" } }, "CLOSED"],
    [{ classStatus: "CANCELLED" }, "CANCELLED"],
    [{ classStatus: "CANCELLED", qr: { window: "CLOSED", closed: true, closedAt: "2026-09-01T13:00:00.000Z" } }, "CANCELLED"],
    [{ classification: "HISTORICAL", qr: { window: "CLOSED" } }, "HISTORICAL"],
    [{ classification: "HISTORICAL" }, "HISTORICAL"],
    [{ classification: null, qr: { window: "CLOSED" } }, "UNCONFIGURED"],
    [{ approval: "MISSING", qr: { window: "CLOSED" } }, "UNCONFIGURED"],
    [{ qr: { window: "CLOSED" } }, "UNAVAILABLE"], // e.g. the QR secret is missing on the server
    [{ qr: null }, "UNAVAILABLE"],
  ];
  for (const [patch, reason] of cases) {
    const a = scannerAvailability(registerFixture(patch));
    assert.equal(a.available, false, reason);
    if (!a.available) {
      assert.equal(a.reason, reason);
      assert.ok(a.title.length > 0 && a.message.length > 0);
      assert.equal(a.opensAt, null);
    }
  }
  const closed = scannerAvailability(registerFixture({ qr: { window: "CLOSED", closed: true, closedAt: "2026-09-01T13:00:00.000Z" } }));
  if (!closed.available) assert.match(closed.message, /closed on 1 Sept 2026, 18:30/);
});

test("register entry: 'Scan QR codes' only while scanning is available; the reason otherwise; no teacher data", () => {
  const open = renderToStaticMarkup(<QrScanEntry register={registerFixture()} />);
  assert.ok(open.includes('href="/dashboard/attendance/lec-1/scan"'));
  assert.ok(text(open).includes("Scan QR codes"));
  for (const patch of [{ qr: { window: "NOT_OPEN" as const } }, { classStatus: "CANCELLED" }, { classification: "HISTORICAL" as const }, { qr: { window: "CLOSED" as const, closed: true, closedAt: "2026-09-01T13:00:00.000Z" } }]) {
    const html = renderToStaticMarkup(<QrScanEntry register={registerFixture(patch)} />);
    assert.ok(!html.includes("/scan"), JSON.stringify(patch));
    assert.ok(!text(html).includes("Scan QR codes"));
    assert.ok(text(html).includes("QR attendance"));
  }
  const panel = source("components", "attendance", "lecture-attendance-register-panel.tsx");
  assert.match(panel, /<QrScanEntry register=\{register\} onCloseQr=\{onCloseQrAttendance\} \/>/, "Stage 5.7b-3e adds the closure action");
});

test("scanner view: camera and manual input are disabled unless available; the unavailable reason is shown", () => {
  const props = (register: AttendanceRegisterResponse): ScannerViewProps => ({
    register,
    availability: scannerAvailability(register),
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
  });
  const open = renderToStaticMarkup(<ScannerView {...props(registerFixture())} />);
  assert.ok(!/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*?Start camera/.test(open));
  assert.ok(!/<input[^>]*disabled=""/.test(open));
  assert.ok(text(open).includes("Present 9 · Late 3 · Pending reviews 1 · Students 30"));

  for (const patch of [{ qr: { window: "NOT_OPEN" as const } }, { qr: { window: "CLOSED" as const, closed: true, closedAt: "2026-09-01T13:00:00.000Z" } }, { classStatus: "CANCELLED" }, { classification: "HISTORICAL" as const }]) {
    const html = renderToStaticMarkup(<ScannerView {...props(registerFixture(patch))} />);
    assert.match(html, /<input[^>]*disabled=""/, JSON.stringify(patch));
    assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Start camera/, JSON.stringify(patch));
    assert.match(html, /aria-label="Scanning unavailable"/);
  }
  const notOpen = text(renderToStaticMarkup(<ScannerView {...props(registerFixture({ qr: { window: "NOT_OPEN" } }))} />));
  assert.ok(notOpen.includes("QR attendance is not open yet") && notOpen.includes("Check again"));
});

// ======================================================================================
// 3. Camera: explicit start, rear camera, cleanup, errors
// ======================================================================================

function fakeCamera(options: { fail?: unknown[]; play?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const failures = (options.fail ?? []).slice();
  const streams: { stopped: number; tracks: number }[] = [];
  const requests: MediaStreamConstraints[] = [];
  const pending: { resolve: () => void }[] = [];
  let hold = false;
  const mediaDevices = {
    getUserMedia: async (constraints: MediaStreamConstraints): Promise<StreamLike> => {
      requests.push(constraints);
      if (failures.length > 0) throw failures.shift();
      if (hold) await new Promise<void>((resolve) => pending.push({ resolve }));
      const record = { stopped: 0, tracks: 2 };
      streams.push(record);
      return { getTracks: () => [{ stop: () => (record.stopped += 1) }, { stop: () => (record.stopped += 1) }] };
    },
  };
  const states: CameraState[] = [];
  let decoding = 0;
  const controller = createCameraController({
    mediaDevices,
    isSecureContext: true,
    attach: async () => {
      log.push("attach");
      if (options.play) await options.play();
    },
    detach: () => log.push("detach"),
    startDecoding: () => {
      decoding += 1;
      log.push("decode:start");
      return () => {
        decoding -= 1;
        log.push("decode:stop");
      };
    },
    onChange: (s) => states.push(s),
  });
  return {
    controller,
    log,
    streams,
    requests,
    states,
    decoding: () => decoding,
    holdNext: () => (hold = true),
    release: () => pending.splice(0).forEach((p) => p.resolve()),
  };
}

const domError = (name: string) => Object.assign(new Error(name), { name });

test("camera: nothing is requested until start(); the rear camera is preferred; stop() and dispose() stop every track", async () => {
  const cam = fakeCamera();
  assert.equal(cam.requests.length, 0, "no camera access before the teacher starts it");
  assert.deepEqual(CAMERA_CONSTRAINTS.video, { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } });
  assert.equal(CAMERA_CONSTRAINTS.audio, false);

  await cam.controller.start();
  assert.deepEqual(cam.requests, [CAMERA_CONSTRAINTS]);
  assert.deepEqual(cam.states.map((s) => s.phase), ["starting", "running"]);
  assert.equal(cam.decoding(), 1);
  await cam.controller.start();
  assert.equal(cam.requests.length, 1, "a second start while running does nothing");

  cam.controller.stop();
  assert.equal(cam.streams[0].stopped, 2, "every track stopped");
  assert.equal(cam.decoding(), 0, "decoding stopped");
  assert.ok(cam.log.includes("detach"));
  assert.equal(cam.controller.state().phase, "idle");

  await cam.controller.start();
  cam.controller.dispose();
  assert.equal(cam.streams[1].stopped, 2, "dispose (unmount / leaving) stops the tracks");
  const before = cam.states.length;
  await cam.controller.start();
  assert.equal(cam.requests.length, 2, "nothing after dispose");
  assert.equal(cam.states.length, before);
});

test("camera: a start that resolves after stop / dispose stops its tracks immediately", async () => {
  const cam = fakeCamera();
  cam.holdNext();
  const starting = cam.controller.start();
  await tick();
  cam.controller.stop();
  cam.release();
  await starting;
  assert.equal(cam.streams[0].stopped, 2);
  assert.equal(cam.decoding(), 0);
  assert.equal(cam.controller.state().phase, "idle");

  const left = fakeCamera();
  left.holdNext();
  const p = left.controller.start();
  await tick();
  left.controller.dispose();
  left.release();
  await p;
  assert.equal(left.streams[0].stopped, 2, "leaving during the permission prompt");
  assert.equal(left.decoding(), 0);
});

test("camera errors: permission denied, no camera, in use, unsupported, insecure page, play() failure; constraints fallback", async () => {
  const kinds: [string, string][] = [
    ["NotAllowedError", "PERMISSION_DENIED"],
    ["PermissionDeniedError", "PERMISSION_DENIED"],
    ["SecurityError", "PERMISSION_DENIED"],
    ["NotFoundError", "NO_CAMERA"],
    ["DevicesNotFoundError", "NO_CAMERA"],
    ["NotReadableError", "IN_USE"],
    ["TrackStartError", "IN_USE"],
    ["AbortError", "IN_USE"],
    ["TypeError", "UNSUPPORTED"],
    ["Weird", "FAILED"],
  ];
  for (const [name, kind] of kinds) {
    assert.equal(classifyCameraError(domError(name)), kind, name);
    const cam = fakeCamera({ fail: [domError(name)] });
    await cam.controller.start();
    const s = cam.controller.state();
    assert.equal(s.phase, "error");
    if (s.phase === "error") {
      assert.equal(s.kind, kind);
      assert.equal(s.message, cameraErrorMessage(s.kind as never));
    }
    assert.equal(cam.decoding(), 0);
  }
  assert.equal(classifyCameraError("x"), "FAILED");
  assert.match(cameraErrorMessage("PERMISSION_DENIED"), /Allow the camera/);
  assert.match(cameraErrorMessage("PERMISSION_DENIED"), /iPhone/);

  // The rear-camera constraints refused: retried once with any camera.
  const fallback = fakeCamera({ fail: [domError("OverconstrainedError")] });
  await fallback.controller.start();
  assert.deepEqual(fallback.requests, [CAMERA_CONSTRAINTS, FALLBACK_CAMERA_CONSTRAINTS]);
  assert.equal(fallback.controller.state().phase, "running");
  const none = fakeCamera({ fail: [domError("OverconstrainedError"), domError("NotFoundError")] });
  await none.controller.start();
  assert.equal(none.controller.state().phase, "error");

  assert.deepEqual(cameraSupport({ isSecureContext: false, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }), { supported: false, kind: "INSECURE_CONTEXT" });
  assert.deepEqual(cameraSupport({ isSecureContext: true, mediaDevices: undefined }), { supported: false, kind: "UNSUPPORTED" });
  assert.deepEqual(cameraSupport({ isSecureContext: true, mediaDevices: {} }), { supported: false, kind: "UNSUPPORTED" });
  const states: CameraState[] = [];
  const unsupported = createCameraController({ mediaDevices: undefined, isSecureContext: true, attach: async () => {}, detach: noop, startDecoding: () => noop, onChange: (s) => states.push(s) });
  await unsupported.start();
  assert.deepEqual(states.map((s) => s.phase), ["error"]);

  // play() refused (e.g. iOS without a gesture): tracks stopped, a clear error.
  const play = fakeCamera({ play: async () => Promise.reject(domError("NotAllowedError")) });
  await play.controller.start();
  assert.equal(play.streams[0].stopped, 2);
  const ps = play.controller.state();
  assert.equal(ps.phase === "error" && ps.kind, "PERMISSION_DENIED");
  const broken = fakeCamera({ play: async () => Promise.reject(new Error("decode")) });
  await broken.controller.start();
  assert.equal(broken.streams[0].stopped, 2);
  const bs = broken.controller.state();
  assert.equal(bs.phase === "error" && bs.kind, "FAILED");
});

test("camera view: Start only by the teacher; errors are alerts; the video is inline and muted (iOS)", () => {
  const idle = renderToStaticMarkup(<CameraSection camera={{ phase: "idle" }} disabled={false} onStart={noop} onStop={noop} />);
  assert.ok(text(idle).includes("Start camera") && text(idle).includes("only when you press Start camera"));
  assert.match(idle, /<video[^>]*muted=""[^>]*playsinline=""|<video[^>]*playsInline/i);
  const running = text(renderToStaticMarkup(<CameraSection camera={{ phase: "running" }} disabled={false} onStart={noop} onStop={noop} />));
  assert.ok(running.includes("Stop camera") && !running.includes("Start camera"));
  const error = renderToStaticMarkup(<CameraSection camera={{ phase: "error", kind: "IN_USE", message: cameraErrorMessage("IN_USE") }} disabled={false} onStart={noop} onStop={noop} />);
  assert.match(error, /role="alert"/);
  assert.ok(text(error).includes("in use by another app"));
  assert.ok(text(error).includes("Start camera"), "the teacher can try again");
});

// ======================================================================================
// 4. Decoding and payload bounds
// ======================================================================================

test("frame scanner: decodes while visible, nothing while hidden, stops cleanly; decode failures are skipped", () => {
  const timers: { fn: () => void; ms: number }[] = [];
  let hidden = false;
  let reads = 0;
  const decoded: string[] = [];
  let script: (string | null | Error)[] = [null, "SLCQR1:abc", new Error("bad frame"), "SLCQR1:def"];
  const scanner = createFrameScanner({
    readFrame: () => {
      reads += 1;
      return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    },
    decode: () => {
      const next = script.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    },
    onDecoded: (t) => decoded.push(t),
    isHidden: () => hidden,
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    cancel: noop,
    intervalMs: 200,
    hiddenIntervalMs: 1000,
  });
  const run = () => timers.shift()!.fn();
  scanner.start();
  run(); // null
  run(); // abc
  run(); // error skipped
  assert.deepEqual(decoded, ["SLCQR1:abc"]);
  assert.equal(timers[0].ms, 200);
  hidden = true;
  const readsBefore = reads;
  run();
  assert.equal(reads, readsBefore, "no frame read or decode while the tab is hidden");
  assert.equal(timers[0].ms, 1000);
  hidden = false;
  run();
  assert.deepEqual(decoded, ["SLCQR1:abc", "SLCQR1:def"]);
  scanner.stop();
  assert.equal(scanner.running(), false);
  script = ["SLCQR1:late"];
  if (timers.length) run();
  assert.equal(decoded.length, 2, "nothing after stop");
  assert.deepEqual(decodeSize(1920, 1080), { width: 720, height: 405 });
  assert.deepEqual(decodeSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(decodeSize(0, 0), { width: 0, height: 0 });
});

test("payload bounds: trimmed; empty refused; 128 characters accepted; 129 refused; non-strings refused", () => {
  assert.equal(QR_PAYLOAD_MAX_LENGTH, 128);
  assert.deepEqual(checkScanPayload(`  ${PAYLOAD}\r\n`), { ok: true, payload: PAYLOAD });
  assert.deepEqual(checkScanPayload("\t"), { ok: false, problem: "EMPTY" });
  assert.deepEqual(checkScanPayload(""), { ok: false, problem: "EMPTY" });
  assert.deepEqual(checkScanPayload(null), { ok: false, problem: "EMPTY" });
  assert.deepEqual(checkScanPayload(42), { ok: false, problem: "EMPTY" });
  assert.equal(checkScanPayload("x".repeat(128)).ok, true);
  assert.deepEqual(checkScanPayload("x".repeat(129)), { ok: false, problem: "TOO_LONG" });
  assert.match(payloadProblemMessage("TOO_LONG"), /not a student attendance QR code/);
  assert.match(payloadProblemMessage("EMPTY"), /Enter or scan/);
  // The panel checks decoded text before queueing it (a long QR never reaches the server).
  assert.match(source("components", "attendance", "qr-scanner-panel.tsx"), /const check = checkScanPayload\(text\);\n\s+if \(!check\.ok\) \{\n\s+showHint\(/);
});

// ======================================================================================
// 5. The request
// ======================================================================================

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  };
  return { calls, fetchImpl };
}
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("request: POST same-origin JSON { clientScanId, payload } only; the mapped response; unexpected shapes are INVALID_RESPONSE", async () => {
  const f = fakeFetch(() => jsonResponse(200, { success: true, data: scanResponse() }));
  const out = await submitQrScan("lec-1", { clientScanId: "abcdefghijklmnop", payload: PAYLOAD }, { fetchImpl: f.fetchImpl });
  assert.equal(f.calls[0].url, "/api/lectures/lec-1/attendance/qr/scans");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.equal(f.calls[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { clientScanId: "abcdefghijklmnop", payload: PAYLOAD });
  assert.ok(out.result.ok);
  if (out.result.ok) assert.deepEqual(out.result.data, scanResponse());

  for (const data of [null, { result: "VALID" }, { ...scanResponse(), replayed: "no" }, { ...scanResponse(), student: { name: 1 } }, { ...scanResponse(), attendance: { status: "PRESENT" } }]) {
    const bad = fakeFetch(() => jsonResponse(200, { success: true, data }));
    const r = await submitQrScan("lec-1", { clientScanId: "abcdefghijklmnop", payload: PAYLOAD }, { fetchImpl: bad.fetchImpl });
    assert.equal(!r.result.ok && r.result.code, "INVALID_RESPONSE", JSON.stringify(data));
  }
  assert.equal(readScanResponse(scanResponse({ student: null, attendance: null }))?.student, null);
  // Extra server fields are never carried over.
  const extra = readScanResponse({ ...scanResponse(), scanEventId: "evt-1", tokenHash: "h" }) as Record<string, unknown>;
  assert.ok(!("scanEventId" in extra) && !("tokenHash" in extra));

  const network = await submitQrScan("lec-1", { clientScanId: "abcdefghijklmnop", payload: PAYLOAD }, { fetchImpl: async () => Promise.reject(new TypeError("offline")) });
  assert.deepEqual([network.result.ok, !network.result.ok && network.result.status, !network.result.ok && network.result.code], [false, 0, "NETWORK_ERROR"]);
});

test("request: 429 reads Retry-After (seconds or a date; 60 when missing); other errors keep their code", async () => {
  const limited = (headers: Record<string, string>) =>
    fakeFetch(() => jsonResponse(429, { success: false, error: { message: "Too many scans.", code: "ATTENDANCE_SCAN_RATE_LIMITED" } }, headers)).fetchImpl;
  const now = () => Date.parse("2026-09-01T12:00:00.000Z");
  assert.equal((await submitQrScan("l", { clientScanId: "abcdefghijklmnop", payload: "x" }, { fetchImpl: limited({ "Retry-After": "60" }), now })).retryAfterSeconds, 60);
  assert.equal((await submitQrScan("l", { clientScanId: "abcdefghijklmnop", payload: "x" }, { fetchImpl: limited({ "Retry-After": "Tue, 01 Sep 2026 12:00:12 GMT" }), now })).retryAfterSeconds, 12);
  assert.equal((await submitQrScan("l", { clientScanId: "abcdefghijklmnop", payload: "x" }, { fetchImpl: limited({}), now })).retryAfterSeconds, 60);
  const r = await submitQrScan("l", { clientScanId: "abcdefghijklmnop", payload: "x" }, { fetchImpl: limited({ "Retry-After": "7" }), now });
  assert.equal(!r.result.ok && r.result.code, "ATTENDANCE_SCAN_RATE_LIMITED");
  const conflict = fakeFetch(() => jsonResponse(409, { success: false, error: { message: "x", code: "ATTENDANCE_QR_NOT_OPEN", details: { opensAt: "2026-09-01T12:00:00.000Z" } } }, { "Retry-After": "5" }));
  const c = await submitQrScan("l", { clientScanId: "abcdefghijklmnop", payload: "x" }, { fetchImpl: conflict.fetchImpl });
  assert.equal(c.retryAfterSeconds, null, "Retry-After only matters for 429");
  assert.deepEqual(!c.result.ok && c.result.details, { opensAt: "2026-09-01T12:00:00.000Z" });

  assert.equal(parseRetryAfter("0"), 1);
  assert.equal(parseRetryAfter("99999"), 3600);
  assert.equal(parseRetryAfter("-5"), null);
  assert.equal(parseRetryAfter("1.5"), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("not a date"), null);
});

// ======================================================================================
// 6. The sequential queue
// ======================================================================================

test("queue: strictly sequential; one request at a time, in order", async () => {
  const gates = [deferred<ScanSubmitOutcome>(), deferred<ScanSubmitOutcome>(), deferred<ScanSubmitOutcome>()];
  let n = 0;
  const h = queueHarness({ submit: () => gates[n++].promise });
  assert.equal(h.queue.enqueue(PAYLOAD, "CAMERA"), "QUEUED");
  assert.equal(h.queue.enqueue(OTHER, "CAMERA"), "QUEUED");
  assert.equal(h.queue.enqueue("SLCQR1:third", "MANUAL"), "QUEUED");
  await settle();
  assert.equal(h.calls.length, 1, "only the first is in flight");
  assert.deepEqual(h.last().pending.map((p) => p.state), ["SENDING", "WAITING", "WAITING"]);
  gates[0].resolve(ok());
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload, OTHER);
  gates[1].resolve(ok());
  await settle();
  gates[2].resolve(ok());
  await settle();
  assert.deepEqual(h.calls.map((c) => c.payload), [PAYLOAD, OTHER, "SLCQR1:third"]);
  assert.equal(h.last().pending.length, 0);
  assert.equal(h.last().feed.length, 3);
  assert.equal(h.queue.pendingCount(), 0);
});

test("queue: a fresh clientScanId per new scan (crypto.randomUUID by default, valid for the server)", async () => {
  const h = queueHarness({ responses: [ok(), ok(), ok()] });
  h.queue.enqueue(PAYLOAD, "MANUAL");
  h.queue.enqueue(OTHER, "MANUAL");
  await settle();
  assert.notEqual(h.calls[0].clientScanId, h.calls[1].clientScanId);

  const ids: string[] = [];
  const real = createScanQueue({
    lectureId: "lec-1",
    onChange: noop,
    submit: async (_l, body) => {
      ids.push(body.clientScanId);
      return ok();
    },
  });
  for (let i = 0; i < 25; i += 1) real.enqueue(`SLCQR1:payload-${i}`, "MANUAL");
  await settle(80);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25, "unique");
  for (const id of ids) assert.match(id, SERVER_ID_PATTERN);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(source("components", "attendance", "qr-scanner-logic.ts"), /globalThis\.crypto\.randomUUID\(\)/);
});

test("queue: the same QR is never sent twice while pending; a camera repeat within 5 s is ignored; manual re-entry after it finished is allowed", async () => {
  let t = 1_000;
  const gate = deferred<ScanSubmitOutcome>();
  let first = true;
  const h = queueHarness({ now: () => t, submit: () => (first ? ((first = false), gate.promise) : Promise.resolve(ok())) });
  assert.equal(h.queue.enqueue(PAYLOAD, "CAMERA"), "QUEUED");
  for (let i = 0; i < 10; i += 1) assert.equal(h.queue.enqueue(PAYLOAD, "CAMERA"), "DUPLICATE", "the same frame while it is being processed");
  assert.equal(h.queue.enqueue(` ${PAYLOAD} `, "MANUAL"), "DUPLICATE", "trimmed before comparing");
  gate.resolve(ok());
  await settle();
  assert.equal(h.calls.length, 1);
  t += SCAN_QUEUE_LIMITS.cameraRepeatMs - 1;
  assert.equal(h.queue.enqueue(PAYLOAD, "CAMERA"), "DUPLICATE", "the camera still sees the same QR");
  assert.equal(h.queue.enqueue(PAYLOAD, "MANUAL"), "QUEUED", "the teacher's explicit entry");
  await settle();
  t += 10_000;
  assert.equal(h.queue.enqueue(PAYLOAD, "CAMERA"), "QUEUED", "after the cooldown");
  await settle();
  assert.equal(h.calls.length, 3);
  assert.notEqual(h.calls[1].clientScanId, h.calls[0].clientScanId, "a new scan gets a new id");
  assert.equal(h.queue.enqueue("", "MANUAL"), "INVALID");
  assert.equal(h.queue.enqueue("x".repeat(129), "CAMERA"), "INVALID");
  assert.equal(h.calls.length, 3, "invalid payloads never reach the server");
});

test("queue: a network failure (no answer) is re-sent automatically with the SAME clientScanId, then succeeds", async () => {
  const h = queueHarness({ responses: [fail(0, "NETWORK_ERROR"), fail(0, "NETWORK_ERROR"), ok(scanResponse({ replayed: true }))] });
  h.queue.enqueue(PAYLOAD, "CAMERA");
  await settle();
  assert.equal(h.calls.length, 3);
  assert.equal(new Set(h.calls.map((c) => c.clientScanId)).size, 1, "the same clientScanId on every attempt");
  assert.deepEqual(h.sleeps, [1_000, 3_000], "backoff between attempts");
  const entry = h.last().feed[0];
  assert.equal(entry.description.title, "Marked Present");
  assert.equal(entry.replayed, true);
  assert.equal(entry.retryable, false);
  assert.ok(h.snapshots.some((s) => s.pending[0]?.state === "RETRYING"));
});

test("queue: after 3 unanswered attempts the scan is 'not confirmed'; Try again re-sends the same clientScanId", async () => {
  const h = queueHarness({ responses: [fail(0, "NETWORK_ERROR"), fail(0, "NETWORK_ERROR"), fail(0, "NETWORK_ERROR"), ok()] });
  h.queue.enqueue(PAYLOAD, "MANUAL");
  await settle();
  assert.equal(h.calls.length, SCAN_QUEUE_LIMITS.networkAttempts);
  const entry = h.last().feed[0];
  assert.equal(entry.description.label, "Not confirmed");
  assert.equal(entry.retryable, true);
  assert.equal(entry.receivedAt, null);
  assert.equal(h.queue.heldPayloadCount(), 1, "kept only for the retry");
  assert.equal(h.queue.retry(entry.id), true);
  await settle();
  assert.equal(h.calls.length, 4);
  assert.equal(h.queue.heldPayloadCount(), 0, "dropped once answered (a manual scan has no camera repeat entry)");
  assert.equal(h.calls[3].clientScanId, h.calls[0].clientScanId, "manual retry keeps the clientScanId");
  assert.equal(h.calls[3].payload, PAYLOAD);
  assert.equal(h.last().feed[0].description.title, "Marked Present");
  assert.equal(h.last().feed.length, 1, "the failed entry was replaced");
  assert.equal(h.queue.retry(entry.id), false, "only once");
});

test("queue: no automatic retry for any HTTP answer (400, 401, 403, 404, 409, 413, 429, 500, 503)", async () => {
  const cases: [number, string, boolean][] = [
    [400, "VALIDATION_ERROR", false],
    [400, "INVALID_JSON", false],
    [401, "UNAUTHORIZED", false],
    [403, "CROSS_ORIGIN_REQUEST_REJECTED", false],
    [404, "LECTURE_NOT_FOUND", false],
    [409, "ATTENDANCE_SCAN_ID_REUSED", false],
    [409, "ATTENDANCE_QR_CLOSED", false],
    [409, "ATTENDANCE_QR_NOT_OPEN", false],
    [409, "ATTENDANCE_LECTURE_HISTORICAL", false],
    [409, "ATTENDANCE_BUSY", true],
    [413, "ATTENDANCE_REQUEST_TOO_LARGE", false],
    [429, "ATTENDANCE_SCAN_RATE_LIMITED", true],
    [500, "INTERNAL_SERVER_ERROR", true],
    [503, "STUDENT_QR_NOT_CONFIGURED", false],
    [503, "ATTENDANCE_APPROVAL_NOT_CONFIGURED", false],
  ];
  for (const [status, code, retryable] of cases) {
    const h = queueHarness({ responses: [fail(status, code, { retryAfterSeconds: status === 429 ? 30 : null })] });
    h.queue.enqueue(PAYLOAD, "MANUAL");
    await settle();
    assert.equal(h.calls.length, 1, `${status} ${code}: sent once`);
    assert.deepEqual(h.sleeps, [], `${code}: no automatic wait-and-resend`);
    const entry = h.last().feed[0];
    assert.equal(entry.retryable, retryable, code);
    assert.equal(entry.description.label.length > 0, true);
    assert.equal(h.queue.heldPayloadCount(), retryable ? 1 : 0, `${code}: the payload is kept only when Try again is offered`);
    h.queue.dispose();
    assert.equal(h.queue.heldPayloadCount(), 0, `${code}: dropped on dispose`);
  }
  assert.equal(scanErrorRetryable({ ok: false, status: 503, code: "X", message: "" }), false);
  assert.equal(scanErrorRetryable({ ok: false, status: 502, code: "INTERNAL_SERVER_ERROR", message: "" }), true);
});

test("queue: a 429 pauses sending for Retry-After seconds; the limited scan is not re-sent automatically", async () => {
  let t = 0;
  const h = queueHarness({ now: () => t, responses: [fail(429, "ATTENDANCE_SCAN_RATE_LIMITED", { retryAfterSeconds: 30 }), ok()] });
  h.queue.enqueue(PAYLOAD, "CAMERA");
  h.queue.enqueue(OTHER, "CAMERA");
  await settle();
  assert.deepEqual(h.sleeps, [30_000], "the next scan waited the server's Retry-After");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload, OTHER, "the limited scan was not re-sent");
  const limited = h.last().feed.find((e) => e.description.label === "Too many scans");
  assert.ok(limited);
  assert.match(limited!.description.detail, /about 30 seconds/);
  assert.equal(limited!.retryable, true);
  t = 31_000;
  const paused = renderToStaticMarkup(<QueueStatus snapshot={{ pending: [], feed: [], pausedUntil: 60_000, signedOut: false }} now={30_000} />);
  assert.ok(text(paused).includes("sending resumes in about 30 s"));
});

test("queue: a 401 stops sending; waiting scans are kept (not silently dropped) and shown", async () => {
  const gate = deferred<ScanSubmitOutcome>();
  const h = queueHarness({ submit: () => gate.promise });
  h.queue.enqueue(PAYLOAD, "MANUAL");
  h.queue.enqueue(OTHER, "MANUAL");
  await settle();
  gate.resolve(fail(401, "UNAUTHORIZED"));
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.last().signedOut, true);
  assert.equal(h.last().pending.length, 1, "the waiting scan is still listed");
  assert.equal(h.last().feed[0].description.title, "Your session has expired");
  assert.equal(h.last().feed[0].retryable, false);
  const status = text(renderToStaticMarkup(<QueueStatus snapshot={h.last()} now={0} />));
  assert.ok(status.includes("1 scan waiting.") && status.includes("session has expired"));
});

test("queue: answers that change the QR / lecture state ask for an immediate register reload; others a debounced one", async () => {
  const h = queueHarness({
    responses: [ok(), fail(409, "ATTENDANCE_QR_CLOSED"), ok(scanResponse({ result: "LECTURE_UNAVAILABLE", effect: "NONE", student: null, attendance: null })), fail(409, "ATTENDANCE_SCAN_ID_REUSED")],
  });
  for (const p of ["SLCQR1:a", "SLCQR1:b", "SLCQR1:c", "SLCQR1:d"]) h.queue.enqueue(p, "MANUAL");
  await settle(40);
  assert.deepEqual(h.events, ["ANSWERED", "STATE_CHANGED", "STATE_CHANGED"]);
});

test("queue: camera stop does not touch the queue; dispose() drops scans, payloads and results and stops all output", async () => {
  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  const stop = panel.slice(panel.indexOf("const stopCamera"), panel.indexOf("const submitManual"));
  assert.doesNotMatch(stop, /queue/i, "stopping the camera leaves queued scans alone");

  const gate = deferred<ScanSubmitOutcome>();
  const h = queueHarness({ submit: () => gate.promise });
  h.queue.enqueue(PAYLOAD, "MANUAL");
  h.queue.enqueue(OTHER, "MANUAL");
  await settle();
  const count = h.snapshots.length;
  assert.equal(h.queue.heldPayloadCount(), 2);
  h.queue.dispose();
  assert.equal(h.queue.heldPayloadCount(), 0, "every payload dropped");
  assert.deepEqual(h.queue.snapshot(), { pending: [], feed: [], pausedUntil: null, signedOut: false });
  gate.resolve(ok());
  await settle();
  assert.equal(h.snapshots.length, count, "no updates after dispose");
  assert.equal(h.calls.length, 1, "the waiting scan was never sent");
  assert.equal(h.queue.enqueue(PAYLOAD, "MANUAL"), "CLOSED");
});

test("queue: the feed is bounded, newest first; snapshots never contain payloads or scan ids", async () => {
  const responses = Array.from({ length: 60 }, (_, i) => ok(scanResponse({ student: { studentId: `s${i}`, name: `Student ${i}`, registrationNumber: null } })));
  const h = queueHarness({ responses });
  const results = [];
  for (let i = 0; i < 60; i += 1) results.push(h.queue.enqueue(`SLCQR1:payload-number-${i}`, "MANUAL"));
  assert.equal(results.filter((r) => r === "QUEUED").length, SCAN_QUEUE_LIMITS.maxPending, "at most 50 waiting at once");
  assert.deepEqual(results.slice(SCAN_QUEUE_LIMITS.maxPending), Array(10).fill("FULL"), "refused visibly, never dropped silently");
  await settle(400);
  for (let i = 50; i < 60; i += 1) assert.equal(h.queue.enqueue(`SLCQR1:payload-number-${i}`, "MANUAL"), "QUEUED");
  await settle(200);
  assert.equal(h.calls.length, 60);
  assert.equal(h.last().feed.length, SCAN_QUEUE_LIMITS.feedLimit);
  assert.equal(h.last().feed[0].student?.name, "Student 59");
  const everything = JSON.stringify(h.snapshots);
  assert.ok(!everything.includes("SLCQR1:"), "no payload in any snapshot");
  assert.ok(!everything.includes("client-scan-id"), "no clientScanId in any snapshot");
  assert.ok(!everything.includes("studentId"), "no student id kept");
});

// ======================================================================================
// 7. Results feed: every result / effect
// ======================================================================================

test("outcomes: every result / effect has its own text label (not colour alone)", () => {
  const cases: [Partial<QrScanResponse>, string, RegExp][] = [
    [{}, "Present", /Marked Present/],
    [{ attendance: { status: "LATE", statusSource: "AUTO", pendingReview: false } }, "Late", /Marked Late/],
    [{ effect: "DUPLICATE" }, "Already recorded", /Already recorded/],
    [{ effect: "REVIEW_REQUIRED", attendance: { status: "ABSENT", statusSource: "TEACHER", pendingReview: true } }, "Needs review", /needs your review/],
    [{ effect: "EVIDENCE_ONLY", attendance: { status: "PRESENT", statusSource: "TEACHER", pendingReview: false } }, "Recorded", /attendance unchanged/],
    [{ effect: "RECORDED_ONLY", afterFinalization: true, attendance: null }, "Recorded only", /after finalization/],
    [{ result: "NOT_ELIGIBLE", effect: "NONE", attendance: null }, "Not eligible", /Not eligible/],
    [{ result: "ELIGIBILITY_UNKNOWN", effect: "NONE", attendance: null }, "Eligibility unknown", /could not be confirmed/],
    [{ result: "INVALID_QR", effect: "NONE", student: null, attendance: null }, "Invalid QR", /Invalid QR/],
    [{ result: "QR_UNVERIFIABLE", effect: "NONE", student: null, attendance: null }, "Unverified", /could not be verified/],
    [{ result: "WRONG_TEACHER", effect: "NONE", student: null, attendance: null }, "Not your student", /Another teacher/],
    [{ result: "LECTURE_UNAVAILABLE", effect: "NONE", student: null, attendance: null }, "Lecture unavailable", /Lecture unavailable/],
  ];
  const labels = new Set<string>();
  for (const [patch, label, title] of cases) {
    const d = describeScanOutcome(scanResponse(patch));
    assert.equal(d.label, label, JSON.stringify(patch));
    assert.match(d.title, title);
    assert.ok(d.detail.length > 20);
    labels.add(`${d.label}|${d.title}`);
  }
  assert.equal(labels.size, cases.length, "each outcome is distinguishable by text");
  assert.match(describeScanOutcome(scanResponse({ effect: "EVIDENCE_ONLY", afterFinalization: true })).detail, /finalized/);
  assert.match(describeScanOutcome(scanResponse({ effect: "STATUS_UPDATED", attendance: { status: "PRESENT", statusSource: "AUTO", pendingReview: true } })).detail, /review is waiting/);
  assert.equal(describeScanOutcome(scanResponse({ result: "SOMETHING_NEW" })).label, "Recorded");
});

test("errors: QR not open (with the time), closed, historical, rate limit (with seconds) and the others have clear text", () => {
  const e = (status: number, code: string, details?: unknown): AttendanceApiError => ({ ok: false, status, code, message: "server text", ...(details ? { details } : {}) });
  assert.match(describeScanError(e(409, "ATTENDANCE_QR_NOT_OPEN", { opensAt: "2026-09-01T12:00:00.000Z" })).detail, /opens at 1 Sept 2026, 17:30/);
  assert.equal(describeScanError(e(409, "ATTENDANCE_QR_NOT_OPEN")).label, "Not open yet");
  assert.equal(describeScanError(e(409, "ATTENDANCE_QR_CLOSED")).label, "QR closed");
  assert.equal(describeScanError(e(409, "ATTENDANCE_LECTURE_HISTORICAL")).label, "Not available");
  assert.match(describeScanError(e(429, "ATTENDANCE_SCAN_RATE_LIMITED"), 45).detail, /about 45 seconds/);
  assert.match(describeScanError(e(429, "ATTENDANCE_SCAN_RATE_LIMITED"), 1).detail, /about 1 second,/);
  assert.equal(describeScanError(e(0, "NETWORK_ERROR")).label, "Not confirmed");
  for (const [status, code] of [[400, "VALIDATION_ERROR"], [413, "ATTENDANCE_REQUEST_TOO_LARGE"], [503, "STUDENT_QR_NOT_CONFIGURED"], [500, "INTERNAL_SERVER_ERROR"], [418, "SOMETHING"], [409, "ATTENDANCE_BUSY"], [409, "ATTENDANCE_SCAN_ID_REUSED"]] as const) {
    const d = describeScanError(e(status, code));
    assert.ok(d.label && d.title && d.detail, code);
    assert.ok(!d.detail.includes("server text"), "never server text");
  }
});

test("feed view: name and registration number, received time, replay note, text badges, retry only when allowed; announced", () => {
  const entries = [
    { id: "a", source: "CAMERA" as const, receivedAt: "2026-09-01T12:35:07.000Z", student: { name: "Amal Perera", registrationNumber: "REG-0042" }, description: describeScanOutcome(scanResponse()), replayed: true, retryable: false },
    { id: "b", source: "MANUAL" as const, receivedAt: null, student: null, description: describeScanError({ ok: false, status: 0, code: "NETWORK_ERROR", message: "" }), replayed: false, retryable: true },
  ];
  const html = renderToStaticMarkup(<ResultsFeed entries={entries} onRetry={noop} />);
  const t = text(html);
  assert.ok(t.includes("Amal Perera") && t.includes("Reg. no. REG-0042"));
  assert.ok(t.includes("Received 18:05:07"), "Colombo time");
  assert.ok(t.includes("Confirmed on a repeated send (recorded once)"));
  assert.ok(t.includes("No server time (not confirmed)"));
  assert.ok(t.includes("Present") && t.includes("Not confirmed"), "status as text");
  assert.equal((html.match(/<button/g) ?? []).length, 1, "one Try again button (the retryable entry)");
  assert.match(html, /<button[^>]*>(?:(?!<\/button>).)*Try again<\/button>/);
  assert.match(html, /<ol[^>]*aria-label="Recent scan results, newest first"/);
  assert.ok(!html.includes("stu-77"), "no student id");
  const empty = text(renderToStaticMarkup(<ResultsFeed entries={[]} onRetry={noop} />));
  assert.ok(empty.includes("not kept after you leave this page"));
  assert.equal(announcementFor(entries[0]), "Marked Present: Amal Perera. Attendance recorded as Present.");
  assert.equal(announcementFor(undefined), "");
});

// ======================================================================================
// 8. Manual / handheld input, accessibility
// ======================================================================================

test("manual entry: labelled, keyboard submit (Enter / Send), no autocomplete or spellcheck, errors announced", () => {
  const html = renderToStaticMarkup(<ManualEntryForm value="" problem={null} disabled={false} onChange={noop} onSubmit={noop} />);
  assert.match(html, /<label for="qr-scanner-manual-input"/);
  assert.match(html, /<input id="qr-scanner-manual-input"[^>]*type="text"/);
  assert.match(html, /autoComplete="off"|autocomplete="off"/i);
  assert.match(html, /spellCheck="false"|spellcheck="false"/i);
  assert.match(html, /<form[^>]*>/);
  assert.match(html, /<button type="submit"/);
  assert.doesNotMatch(html, /maxLength|maxlength/i, "a long value is refused with a message, never silently truncated");
  const withProblem = renderToStaticMarkup(<ManualEntryForm value="x" problem="Enter or scan a QR code first." disabled={false} onChange={noop} onSubmit={noop} />);
  assert.match(withProblem, /role="alert"/);
  assert.match(withProblem, /aria-invalid="true"/);

  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  const submit = panel.slice(panel.indexOf("const submitManual"), panel.indexOf("const retry = useCallback"));
  assert.match(submit, /const result = queue\.enqueue\(check\.payload, "MANUAL"\);\n\s+setManualValue\(""\);/, "the input is cleared after every submission");
  assert.match(submit, /inputRef\.current\?\.focus\(\)/, "focus stays in the field for the next handheld scan");
  assert.match(submit, /queue\.enqueue\(check\.payload, "MANUAL"\)/);
});

test("accessibility: a polite live region announces results; alerts for errors; heading focus; leave confirmation", () => {
  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  assert.match(panel, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(panel, /document\.getElementById\(SCANNER_HEADING_ID\)\?\.focus\(\)/);
  assert.match(panel, /document\.getElementById\(CAMERA_ERROR_ID\)\?\.focus\(\)/);
  assert.match(panel, /document\.getElementById\(LEAVE_CONFIRM_ID\)\?\.focus\(\)/);
  const buttons = [...panel.matchAll(/<button\b[\s\S]*?className="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 9);
  for (const classes of buttons) assert.match(classes, /min-h-\[44px\]/, "touch-size buttons");
});

// ======================================================================================
// 9. Register refresh
// ======================================================================================

function fakeTimers() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await settle();
      }
      t = end;
    },
    count: () => timers.size,
  };
}

test("refresh: debounced (one reload after scanning pauses, at most every 20 s while it continues), never per scan", async () => {
  const clock = fakeTimers();
  let reloads = 0;
  const r = createDebouncedRefresh({ refresh: async () => (reloads += 1, true), delayMs: 4_000, maxWaitMs: 20_000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let i = 0; i < 10; i += 1) {
    r.schedule();
    await clock.advance(1_000);
  }
  // 10 s of continuous scans: no reload yet (each scan pushed it back), the max wait not reached.
  assert.equal(reloads, 0);
  await clock.advance(4_000);
  assert.equal(reloads, 1, "one reload for ten scans");

  for (let i = 0; i < 30; i += 1) {
    r.schedule();
    await clock.advance(1_000);
  }
  assert.equal(reloads, 2, "continuous scanning still reloads within 20 s");
  await clock.advance(10_000);
  assert.equal(reloads, 3);
  await clock.advance(60_000);
  assert.equal(reloads, 3, "nothing without activity");
  r.dispose();
  r.schedule();
  await clock.advance(60_000);
  assert.equal(reloads, 3, "nothing after dispose");
});

test("refresh: flush() reloads now; a request during a reload runs once more; a failed reload is harmless", async () => {
  const gate = deferred<boolean>();
  let reloads = 0;
  const r = createDebouncedRefresh({
    refresh: () => {
      reloads += 1;
      return reloads === 1 ? gate.promise : Promise.reject(new Error("offline"));
    },
  });
  const first = r.flush();
  await tick();
  const second = r.flush();
  await tick();
  assert.equal(reloads, 1, "one reload at a time");
  gate.resolve(false);
  await first;
  await second;
  await settle();
  assert.equal(reloads, 2, "the request made during the reload ran afterwards");
  await r.flush();
  assert.equal(reloads, 3, "a rejected reload does not break later ones");
  r.dispose();
});

test("refresh in the panel: scans schedule a debounced reload, state changes flush it, failures keep the shown register", () => {
  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  assert.match(panel, /if \(event\.kind === "STATE_CHANGED"\) void refresher\.flush\(\);\n\s+else refresher\.schedule\(\);/);
  const load = panel.slice(panel.indexOf("const load = useCallback"), panel.indexOf("const showHint"));
  assert.match(load, /if \(mode === "initial"\) setState\(\{ kind: "error", error: result \}\);\n\s+else setRefreshFailed\(true\);/, "a failed refresh keeps the register");
  assert.match(panel, /router\.push\(registerHref\)/, "leaving opens the register, which loads it fresh");
  const notice = text(
    renderToStaticMarkup(
      <ScannerView
        register={registerFixture()}
        availability={{ available: true }}
        refreshFailed
        camera={{ phase: "idle" }}
        hint={null}
        manualValue=""
        manualProblem={null}
        queue={{ pending: [], feed: [], pausedUntil: null, signedOut: false }}
        now={0}
        announcement=""
        leaveConfirm={false}
        onBack={noop}
        onStay={noop}
        onLeave={noop}
        onRefresh={noop}
        onStartCamera={noop}
        onStopCamera={noop}
        onManualChange={noop}
        onManualSubmit={noop}
        onRetry={noop}
      />
    )
  );
  assert.ok(notice.includes("could not be refreshed") && notice.includes("Kinematics II"));
  // The attendance summary is the server's; the scanner computes no percentages.
  assert.doesNotMatch(panel, /percent|%/i);
});

// ======================================================================================
// 10. Cleanup, privacy and client-bundle safety
// ======================================================================================

test("cleanup: unmount disposes the camera, decoder loop, queue and refresher; leaving asks while scans are pending", () => {
  const panel = source("components", "attendance", "qr-scanner-panel.tsx");
  const cleanup = panel.slice(panel.indexOf("    return () => {\n      window.removeEventListener(\"pagehide\""), panel.indexOf("}, [lectureId, load, showHint]);"));
  for (const call of ["cameraController.dispose()", "frames.stop()", "queue.dispose()", "refresher.dispose()", 'window.removeEventListener("pagehide", onPageHide)', "decoderRef.current = null"]) {
    assert.ok(cleanup.includes(call), call);
  }
  assert.match(panel, /window\.addEventListener\("pagehide", onPageHide\)/, "the camera stops when the page is hidden for navigation");
  assert.match(panel, /window\.addEventListener\("beforeunload", onBeforeUnload\)/);
  const back = panel.slice(panel.indexOf("const back = useCallback"), panel.indexOf("if (state.kind === \"loading\")"));
  assert.match(back, /pendingCount\(\) \?\? 0\) > 0\) setLeaveConfirm\(true\)/);
  const leave = panel.slice(panel.indexOf("const leave = useCallback"), panel.indexOf("const back = useCallback"));
  for (const call of ["cameraRef.current?.dispose()", "queueRef.current?.dispose()", "setSnapshot(EMPTY_SNAPSHOT)", 'setManualValue("")']) assert.ok(leave.includes(call), call);
});

test("privacy: no browser storage, no logging, no payload in the DOM output of the scanner modules", () => {
  const files = ["qr-scanner-logic.ts", "qr-camera.ts", "qr-scanner-panel.tsx", "qr-scan-entry.tsx"].map((f) => source("components", "attendance", f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
  for (const code of files) {
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./);
    assert.doesNotMatch(code, /console\./);
  }
  const html = renderToStaticMarkup(<QueueStatus snapshot={{ pending: [{ id: "scan-1", source: "CAMERA", state: "SENDING", attempt: 1 }], feed: [], pausedUntil: null, signedOut: false }} now={0} />);
  assert.ok(!html.includes("SLCQR1"));
});

test("client bundle: no scanner module imports the token library, server-only QR state, rate limiter, Prisma or services at runtime", () => {
  const dir = path.join(ROOT, "components", "attendance");
  const files = readdirSync(dir).map((f) => path.join("components", "attendance", f)).concat([path.join("app", "dashboard", "attendance", "[lectureId]", "scan", "page.tsx")]);
  for (const file of files) {
    const code = source(file);
    assert.doesNotMatch(code, /student-qr-token|lecture-attendance-qr-state|qr-scan-rate-limit|@\/lib\/prisma|server-only/, file);
    for (const m of code.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(@\/services\/[^"]+)"/gm)) assert.ok(m[1], `${file}: only type imports from ${m[2]}`);
  }
  const logic = source("components", "attendance", "qr-scanner-logic.ts");
  assert.doesNotMatch(logic, /from "jsqr"|import\("jsqr"\)/, "the decoder is loaded by the panel only");
  assert.match(source("components", "attendance", "qr-scanner-panel.tsx"), /import\("jsqr"\)/, "loaded on the first Start camera");
});

test("dependencies: jsqr 1.4.0 is a runtime dependency (moved, same version) in package.json and pnpm-lock.yaml", () => {
  const pkg = JSON.parse(source("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  assert.equal(pkg.dependencies.jsqr, "1.4.0");
  assert.equal(pkg.devDependencies.jsqr, undefined);
  const lock = source("pnpm-lock.yaml");
  const root = lock.slice(lock.indexOf("importers:"), lock.indexOf("\npackages:"));
  const deps = root.slice(root.indexOf("    dependencies:"), root.indexOf("    devDependencies:"));
  const dev = root.slice(root.indexOf("    devDependencies:"));
  assert.match(deps, /      jsqr:\n        specifier: 1\.4\.0\n        version: 1\.4\.0\n/);
  assert.doesNotMatch(dev, /jsqr/);
  assert.match(lock, /\n  jsqr@1\.4\.0:\n/);
});
