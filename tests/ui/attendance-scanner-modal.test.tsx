/**
 * The QR scanner as a modal on the Attendance page
 * (components/attendance/qr-scanner-modal.tsx), built on the existing
 * QrScannerPanel (variant="modal"); the standalone route keeps working.
 *
 * No DOM library is installed, so: the camera lifecycle runs on the REAL
 * camera controller (qr-camera.ts) with a fake getUserMedia and tracks,
 * driven exactly as the panel drives it (one controller per mount, start
 * only from Start camera, dispose on unmount); the scan queue is the real
 * one over a scripted submit; the views and the modal are rendered with
 * react-dom/server; the React wiring (no navigation, keyed remount, cleanup)
 * is checked from source. Clicking through a real browser with a real
 * camera remains a manual check.
 *
 *   npm run test:attendance-ui
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { AttendanceRegisterResponse } from "../../components/attendance/attendance-ui";
import { createCameraController, type CameraState, type StreamLike } from "../../components/attendance/qr-camera";
import { checkScanPayload, createScanQueue, type QrScanResponse, type ScanQueueSnapshot } from "../../components/attendance/qr-scanner-logic";
import { MANUAL_INPUT_ID, ScannerErrorView, ScannerView, scannerCountsText, scannerLectureTime, type ScannerViewProps } from "../../components/attendance/qr-scanner-panel";
import { QrScannerModal, SCANNER_MODAL_CLASSES, SCANNER_MODAL_TITLE_ID } from "../../components/attendance/qr-scanner-modal";
import { scannerAction, withLectureOption } from "../../components/attendance/attendance-take-section";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const noop = () => {};

const TAKE = () => source("components", "attendance", "attendance-take-section.tsx");
const MODAL = () => source("components", "attendance", "qr-scanner-modal.tsx");
const PANEL = () => source("components", "attendance", "qr-scanner-panel.tsx");

function register(): AttendanceRegisterResponse {
  return {
    lecture: { id: "lec-1", classId: "class-1", title: "Kinematics II", classStatus: "SCHEDULED", date: "2026-11-23T03:30:00.000Z", endDate: "2026-11-23T05:30:00.000Z" },
    register: { lectureId: "lec-1", exists: true, scheduledStartAt: "2026-11-23T03:30:00.000Z", scheduledEndAt: null, graceMinutes: 10, version: 1, finalized: false, finalizedAt: null },
    configuration: { approval: "OK", evidence: "OK" },
    classification: "LIVE",
    students: [],
    summary: { students: 30, withRecord: 12, recordStatus: { PRESENT: 9, LATE: 3, ABSENT: 0, EXCUSED: 0 }, pendingReviews: 1 },
    absencePreview: null,
    onlineEvidence: null,
    activeSessions: { active: false, count: 0 },
    finalization: { readiness: { allowed: false, reason: "BEFORE_END" }, configured: true },
    qr: { closed: false, closedAt: null, opensAt: "2026-11-23T03:00:00.000Z", window: "OPEN" },
  } as AttendanceRegisterResponse;
}

const EMPTY: ScanQueueSnapshot = { pending: [], feed: [], pausedUntil: null, signedOut: false };

function view(patch: Partial<ScannerViewProps> = {}) {
  return renderToStaticMarkup(
    <ScannerView
      register={register()}
      availability={{ available: true }}
      refreshFailed={false}
      camera={{ phase: "idle" }}
      hint={null}
      manualValue=""
      manualProblem={null}
      queue={EMPTY}
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
      variant="modal"
      className="Physics – Grade 12"
      {...patch}
    />
  );
}

// ---- A shared fake camera device; each "opening" mounts a new controller, as the panel does ----

function cameraDevice() {
  const streams: { live: number; stopped: number }[] = [];
  const requests: number[] = [];
  const holds: (() => void)[] = [];
  let hold = false;
  const mediaDevices = {
    getUserMedia: async (): Promise<StreamLike> => {
      requests.push(1);
      if (hold) await new Promise<void>((resolve) => holds.push(resolve));
      const record = { live: 2, stopped: 0 };
      streams.push(record);
      const track = () => ({
        stop: () => {
          record.stopped += 1;
          record.live -= 1;
        },
      });
      return { getTracks: () => [track(), track()] };
    },
  };
  /** One panel mount: its own controller over the shared device. */
  const mount = () => {
    const states: CameraState[] = [];
    const controller = createCameraController({
      mediaDevices,
      isSecureContext: true,
      attach: async () => {},
      detach: () => {},
      startDecoding: () => () => {},
      onChange: (s) => states.push(s),
    });
    return { controller, states };
  };
  const liveTracks = () => streams.reduce((n, s) => n + s.live, 0);
  return {
    streams,
    requests,
    mount,
    liveTracks,
    holdNext: () => (hold = true),
    release: () => {
      hold = false;
      holds.splice(0).forEach((resolve) => resolve());
    },
  };
}

// =========================================================================================================
// 1-3. Opening and closing without navigation
// =========================================================================================================

test("1. an existing lecture opens the scanner modal on the page (no navigation)", () => {
  assert.deepEqual(scannerAction("C1", "L1"), { kind: "OPEN_SCANNER", lectureId: "L1" });
  const take = code(TAKE());
  assert.match(take, /if \(action\.kind === "OPEN_SCANNER"\) openScannerModal\(action\.lectureId\);/);
  for (const src of [take, code(MODAL())]) {
    assert.doesNotMatch(src, /useRouter|router\.|scannerPath|window\.location|<Link /, "nothing navigates");
  }
  assert.match(take, /<QrScannerModal\s+key=\{`\$\{scanner\.lectureId\}:\$\{scanner\.opening\}`\}\s+lectureId=\{scanner\.lectureId\}/);
});

test("2. a newly created lecture is selected (register mode, its month shown) and the modal opens for it (no navigation)", () => {
  const take = code(TAKE());
  const ready = take.slice(take.indexOf("const lectureReady"), take.indexOf("const closeScanner"));
  for (const step of [
    "setDialogOpen(false)",
    "setLectures((previous) => withLectureOption(previous, lecture))",
    "setLectures(withLectureOption([], lecture))",
    "setLectureId(lecture.id)",
    "setMonth(key)",
    "openScannerModal(lecture.id)",
  ]) {
    assert.ok(ready.includes(step), step);
  }
  assert.match(take, /onLectureReady=\{lectureReady\}/);
  // The dialog hands over the created lecture (and "Use this lecture" the existing one).
  const dialog = code(source("components", "attendance", "attendance-lecture-dialog.tsx"));
  assert.match(dialog, /props\.onLectureReady\(\{ id: created\.id, title: created\.title, date: created\.date, endDate: created\.endDate \}\)/);
  assert.match(dialog, /onClick=\{\(\) => props\.onLectureReady\(lecture\)\}/);

  // The new lecture appears in the month's selector at once (oldest first, like the month's list; never twice).
  const existing = [
    { id: "early", title: "Early", date: "2026-11-02T03:30:00.000Z", endDate: null, classStatus: "COMPLETED" },
    { id: "late", title: "Late", date: "2026-11-27T03:30:00.000Z", endDate: null, classStatus: "SCHEDULED" },
  ];
  const added = withLectureOption(existing, { id: "new", title: "Physics – 23 Nov 2026", date: "2026-11-23T03:30:00.000Z", endDate: null });
  assert.deepEqual(added.map((l) => l.id), ["early", "new", "late"]);
  assert.equal(added[1].classStatus, "SCHEDULED");
  assert.deepEqual(withLectureOption(added, { id: "new", title: "x", date: "2026-11-23T03:30:00.000Z", endDate: null }).map((l) => l.id), ["early", "new", "late"]);
});

test("3. closing returns to the Attendance page: class and lecture kept, matrix reloaded; the panel exits through onExit, not the register route", () => {
  const take = code(TAKE());
  const close = take.slice(take.indexOf("const closeScanner"), take.indexOf("const openSelectedScanner"));
  assert.match(close, /setScanner\(null\)/);
  // Register mode: the register reloads (new scans); overview mode: the matrix. The matrix is
  // not fetched in register mode and reloads when the overview returns (attendance-month-workspace).
  assert.match(close, /if \(lectureId\) setRegisterRefresh\(\(n\) => n \+ 1\);\s+else reloadMatrix\(\);/);
  assert.match(take, /\}, \[classId, month, matrixAttempt, overview\]\);/);
  assert.match(take, /const reloadMatrix = useCallback\(\(\) => setMatrixAttempt\(\(n\) => n \+ 1\), \[\]\);/);
  assert.doesNotMatch(close, /setClassId|setLectureId|setMonth/, "the selection is kept");
  assert.match(take, /onClose=\{closeScanner\}/);
  assert.match(code(MODAL()), /onExit=\{onClose\}/);
  const leave = code(PANEL()).slice(code(PANEL()).indexOf("const leave = useCallback"), code(PANEL()).indexOf("const back = useCallback"));
  assert.match(leave, /if \(onExit\) onExit\(\);\n\s+else router\.push\(registerHref\);/);
  // The modal's close button and Escape use the panel's own close request (asks while scans are pending).
  const modal = code(MODAL());
  assert.match(modal, /const request = closeRequestRef\.current;\n\s+if \(request\) request\(\);\n\s+else onClose\(\);/);
  assert.match(modal, /useModalDialog\(\{ open: true, dialogRef, overlayRef, canClose: \(\) => true, onClose: requestClose/);
  assert.match(code(PANEL()), /closeRequestRef\.current = back;/);
  // In the modal, a load error offers Close (no page link).
  const error = renderToStaticMarkup(<ScannerErrorView error={{ ok: false, status: 0, code: "NETWORK_ERROR", message: "Could not reach the server." }} registerHref="/dashboard/attendance/x" onRetry={noop} onClose={noop} />);
  assert.match(text(error), /Close scanner/);
  assert.doesNotMatch(error, /href=/);
});

// =========================================================================================================
// 4-7, 12. Camera lifecycle
// =========================================================================================================

test("4. closing the modal (unmount → dispose) stops every camera track; nothing stays live", async () => {
  const device = cameraDevice();
  const opening = device.mount();
  await opening.controller.start();
  assert.equal(device.liveTracks(), 2);
  opening.controller.dispose(); // the panel's unmount cleanup (and leave())
  assert.equal(device.liveTracks(), 0);
  assert.equal(device.streams[0].stopped, 2);
  // Wiring: closing unmounts the panel (rendered only while open), whose cleanup disposes the camera.
  assert.match(code(TAKE()), /\{scanner && classId \? \(\n\s+<QrScannerModal/);
  const panel = PANEL();
  const cleanup = panel.slice(panel.indexOf('    return () => {\n      window.removeEventListener("pagehide"'), panel.indexOf("}, [lectureId, load, showHint]);"));
  for (const call of ["cameraController.dispose()", "frames.stop()", "queue.dispose()", "refresher.dispose()", "announcer.dispose()"]) assert.ok(cleanup.includes(call), call);
  for (const type of ["pagehide"]) assert.ok(cleanup.includes(`window.removeEventListener("${type}"`), type);
  assert.ok(cleanup.includes("window.removeEventListener(type, onUserGesture, true)"), "the audio unlock listeners are removed");
  assert.match(code(MODAL()), /document\.body\.style\.overflow = previous;/, "the page scroll lock is released");
});

test("5. the camera never starts by itself: opening requests nothing; the view says it waits for Start camera", () => {
  const device = cameraDevice();
  device.mount();
  assert.equal(device.requests.length, 0, "a mount requests no camera access");
  const html = text(view());
  assert.match(html, /Start camera/);
  assert.match(html, /The camera starts only when you press Start camera\./);
  // The only start is the Start camera handler; the modal itself never touches media devices.
  const panel = code(PANEL());
  assert.equal((panel.match(/cameraRef\.current\?\.start\(\)/g) ?? []).length, 1);
  assert.match(panel.slice(panel.indexOf("const startCamera = useCallback"), panel.indexOf("const stopCamera")), /cameraRef\.current\?\.start\(\)/);
  assert.match(panel, /onStartCamera=\{startCamera\}/);
  assert.doesNotMatch(code(MODAL()), /getUserMedia|mediaDevices|\.start\(\)/);
});

test("6. the camera starts after the teacher's explicit Start camera", async () => {
  const device = cameraDevice();
  const opening = device.mount();
  await opening.controller.start();
  assert.equal(device.requests.length, 1);
  assert.deepEqual(opening.states.map((s) => s.phase), ["starting", "running"]);
  const running = text(view({ camera: { phase: "running" } }));
  assert.match(running, /Stop camera/);
  assert.match(running, /Point the camera at a student's QR code/);
});

test("7. reopening the modal mounts a fresh controller: a new stream, never the stopped one", async () => {
  const device = cameraDevice();
  const first = device.mount();
  await first.controller.start();
  first.controller.dispose(); // close
  await first.controller.start(); // a disposed controller never starts again
  assert.equal(device.requests.length, 1);

  const second = device.mount(); // reopen (new key → new panel → new controller)
  assert.equal(device.requests.length, 1, "reopening requests nothing until Start camera");
  await second.controller.start();
  assert.equal(device.requests.length, 2);
  assert.equal(device.streams.length, 2);
  assert.equal(device.streams[0].stopped, 2, "the first stream stays stopped");
  assert.equal(device.streams[1].live, 2, "the new stream is live");
  second.controller.dispose();
  assert.equal(device.liveTracks(), 0);
  // Every opening is a new key, so React mounts a new panel.
  assert.match(code(TAKE()), /setScanner\(\(previous\) => \(\{\s*lectureId: id,\s*opening: \(previous\?\.opening \?\? 0\) \+ 1,?\s*\}\)\)/);
});

test("12. no duplicate camera streams: repeated / concurrent Start, Strict Mode double mount, close during the permission prompt", async () => {
  const device = cameraDevice();
  const opening = device.mount();
  await Promise.all([opening.controller.start(), opening.controller.start()]);
  await opening.controller.start();
  assert.equal(device.requests.length, 1, "one stream per controller");
  opening.controller.dispose();

  // React Strict Mode (development): mount, cleanup, mount again; only the second controller lives.
  const strictA = device.mount();
  strictA.controller.dispose();
  const strictB = device.mount();
  await strictA.controller.start();
  assert.equal(device.requests.length, 1, "the disposed first mount never opens the camera");
  await strictB.controller.start();
  assert.equal(device.liveTracks(), 2);
  strictB.controller.dispose();

  // Closed while the browser's permission prompt is open: the late stream is stopped at once.
  const prompt = device.mount();
  device.holdNext();
  const starting = prompt.controller.start();
  prompt.controller.dispose();
  device.release();
  await starting;
  assert.equal(device.liveTracks(), 0, "nothing left running in the background");
});

// =========================================================================================================
// 8-9. Manual input and results (the same queue and views)
// =========================================================================================================

const scanResponse = (): QrScanResponse => ({
  result: "VALID",
  effect: "STATUS_UPDATED",
  replayed: false,
  receivedAt: "2026-11-23T03:35:07.000Z",
  afterFinalization: false,
  student: { studentId: "stu-77", name: "Amal Perera", registrationNumber: "REG-0042" },
  attendance: { status: "PRESENT", statusSource: "AUTO", pendingReview: false },
} as QrScanResponse);

test("8-9. manual / handheld input still goes through the one scan queue; recent results are listed in the modal", async () => {
  const html = view();
  assert.match(html, new RegExp(`id="${MANUAL_INPUT_ID}"`));
  assert.match(text(html), /Manual or handheld scanner/);
  assert.match(text(html), /No scans yet/);

  const snapshots: ScanQueueSnapshot[] = [];
  const calls: string[] = [];
  const queue = createScanQueue({
    lectureId: "lec-1",
    onChange: (s) => snapshots.push(s),
    newClientScanId: () => "client-scan-id-0001",
    sleep: async () => {},
    submit: async (lectureId, body) => {
      calls.push(`${lectureId}:${body.payload}`);
      return { result: { ok: true, status: 200, data: scanResponse() }, retryAfterSeconds: null };
    },
  });
  const check = checkScanPayload("  SLCQR1.manual-entry  ");
  assert.ok(check.ok);
  assert.equal(queue.enqueue(check.ok ? check.payload : "", "MANUAL"), "QUEUED");
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["lec-1:SLCQR1.manual-entry"]);
  const last = snapshots[snapshots.length - 1];
  assert.equal(last.feed.length, 1);
  assert.equal(last.feed[0].source, "MANUAL");
  queue.dispose();

  const results = text(view({ queue: last }));
  assert.match(results, /Amal Perera/);
  assert.match(results, /Reg\. no\. REG-0042/);
  assert.match(results, /Manual entry/);
  // The panel's manual submit is unchanged (the same queue, same messages).
  assert.match(code(PANEL()), /const result = queue\.enqueue\(check\.payload, "MANUAL"\);/);
});

// =========================================================================================================
// 10. The standalone route
// =========================================================================================================

test("10. the standalone scanner route still renders the page scanner with its back-to-register button", () => {
  const page = source("app", "dashboard", "attendance", "[lectureId]", "scan", "page.tsx");
  assert.match(page, /<QrScannerPanel lectureId=\{params\.lectureId\} \/>/, "no new props: the page behaviour");
  const html = view({ variant: undefined, className: undefined });
  assert.match(html, /<h1 id="qr-scanner-heading"/);
  assert.match(text(html), /Close scanner and return to the register/);
  assert.doesNotMatch(html, /data-scanner-variant="modal"/);
  // Panel defaults: the page variant, the register route on leaving.
  assert.match(code(PANEL()), /export function QrScannerPanel\(\{ lectureId, variant = "page", className = null, onExit, closeRequestRef \}: QrScannerPanelProps\)/);
});

// =========================================================================================================
// 11. Responsive layout and the modal content
// =========================================================================================================

test("modal content: class, lecture title, Sri Lankan date and time, Present / Late / Pending reviews / Students, camera, manual input, results", () => {
  const html = view();
  const t = text(html);
  assert.match(t, /Physics – Grade 12/);
  assert.match(html, /<h2 id="qr-scanner-heading" tabindex="-1"/);
  assert.match(t, /Kinematics II/);
  assert.match(t, /23 Nov 2026, 09:00 – 23 Nov 2026, 11:00 \(Sri Lankan time\)/);
  for (const [label, value] of [["Present", 9], ["Late", 3], ["Pending reviews", 1], ["Students", 30]] as const) {
    assert.match(t, new RegExp(`${label} ${value}`));
  }
  assert.match(t, /Camera/);
  assert.match(t, /Recent scans/);
  assert.doesNotMatch(t, /Close scanner and return to the register/, "the modal has its own close button");
  assert.equal(scannerCountsText(register().summary), "Present 9 · Late 3 · Pending reviews 1 · Students 30");
  assert.equal(scannerLectureTime({ ...register().lecture, endDate: null }), "23 Nov 2026, 09:00");
});

test("11. responsive: full screen with safe areas on phones, most of the screen on tablets, ≤ 960 px × 90vh on desktops; no horizontal scroll", () => {
  const c = SCANNER_MODAL_CLASSES;
  // Phones (< 640 px): full screen, dynamic viewport height, safe areas, large close button.
  assert.match(c.dialog, /(^| )h-\[100dvh\] w-full /);
  assert.match(c.overlay, /items-stretch/);
  assert.match(c.header, /pt-\[max\(0\.5rem,env\(safe-area-inset-top\)\)\]/);
  assert.match(c.header, /pl-\[max\(1rem,env\(safe-area-inset-left\)\)\]/);
  assert.match(c.header, /pr-\[max\(0\.5rem,env\(safe-area-inset-right\)\)\]/);
  assert.match(c.body, /pb-\[max\(0\.75rem,env\(safe-area-inset-bottom\)\)\]/);
  assert.match(c.close, /min-h-\[44px\] min-w-\[44px\]/);
  assert.match(c.header, /shrink-0/, "the header never scrolls away");
  assert.match(c.body, /overflow-y-auto overflow-x-hidden/);
  assert.match(c.dialog, /min-w-0/);
  // Tablets (≥ 640 px): centred, nearly the whole screen, internal scrolling.
  assert.match(c.overlay, /sm:items-center sm:p-4/);
  assert.match(c.dialog, /sm:h-auto sm:max-h-\[94vh\] sm:rounded-2xl/);
  // Desktops (≥ 1024 px): at most 960 px wide and 90vh tall.
  assert.match(c.dialog, /lg:max-h-\[90vh\] lg:max-w-\[960px\]/);

  // The content adapts: one column, two on desktops; counts in 2 then 4 columns; the video fills the width.
  const html = view({ camera: { phase: "running" } });
  assert.match(html, /grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2/);
  assert.match(html, /grid grid-cols-2 gap-2 sm:grid-cols-4/);
  assert.match(html, /<video[^>]*class="aspect-\[4\/3\] w-full object-cover"/);
  assert.doesNotMatch(html, /\btruncate\b|line-clamp|w-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
});

test("the modal renders as an accessible dialog (labelled, close button first) and loads the same panel lazily", () => {
  const html = renderToStaticMarkup(<QrScannerModal lectureId="lec-1" className="Physics" onClose={noop} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, new RegExp(`aria-labelledby="${SCANNER_MODAL_TITLE_ID}"`));
  assert.match(html, /aria-label="Close the QR scanner"/);
  assert.match(text(html), /QR attendance scanner Physics/);
  const modal = code(MODAL());
  assert.match(modal, /import\("@\/components\/attendance\/qr-scanner-panel"\)\.then\(\(mod\) => mod\.QrScannerPanel\)/);
  assert.match(modal, /<QrScannerPanel lectureId=\{lectureId\} variant="modal" className=\{className\} onExit=\{onClose\} closeRequestRef=\{closeRequestRef\} \/>/);
  assert.doesNotMatch(modal, /createScanQueue|createCameraController|submitQrScan|fetch\(/, "no second scanner implementation");
});
