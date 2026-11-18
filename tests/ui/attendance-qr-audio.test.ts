/**
 * QR attendance scanner: audio feedback (components/attendance/scan-audio.ts)
 * and its wiring through the scan queue's onAnswered / onFailed
 * (components/attendance/qr-scanner-logic.ts) into the panel, with the
 * payment snapshot (components/attendance/payment-snapshot.ts). Fakes only:
 * a fake speechSynthesis / utterance, a fake chime, fake audio elements, a
 * scripted submit. No browser, no audio device, no network.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createPaymentSnapshot, type PaymentSnapshotState } from "../../components/attendance/payment-snapshot";
import { createScanQueue, SCAN_QUEUE_LIMITS, type QrScanResponse, type ScanSubmitOutcome } from "../../components/attendance/qr-scanner-logic";
import {
  ANNOUNCEMENT_VOICE_SETTINGS,
  createCuePlayer,
  createScanAnnouncer,
  cueForNewMark,
  pickAnnouncementVoice,
  SCAN_CUE_SOURCES,
  SCAN_FEEDBACK_TEXT,
  scanFeedbackFor,
  shouldAnnounceScan,
  spokenName,
  type AudioElementLike,
  type SpeechLike,
  type UtteranceLike,
  type VoiceLike,
} from "../../components/attendance/scan-audio";

const ROOT = path.join(__dirname, "..", "..");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (times = 30) => {
  for (let i = 0; i < times; i += 1) await tick();
};

function answer(patch: Partial<QrScanResponse> = {}): QrScanResponse {
  return {
    result: "VALID",
    effect: "STATUS_UPDATED",
    replayed: false,
    receivedAt: "2026-09-01T12:35:07.000Z",
    afterFinalization: false,
    student: { studentId: "stu-1", name: "Manori Jayasinghe", registrationNumber: "REG-1" },
    attendance: { status: "PRESENT", statusSource: "AUTO", pendingReview: false },
    ...patch,
  };
}
const student = (studentId: string) => ({ student: { studentId, name: `Student ${studentId}`, registrationNumber: null } });
const ok = (data: QrScanResponse): ScanSubmitOutcome => ({ result: { ok: true, status: 200, data }, retryAfterSeconds: null });
const fail = (status: number, code: string): ScanSubmitOutcome => ({ result: { ok: false, status, code, message: "safe message" }, retryAfterSeconds: null });

const ready = (ids: string[]): PaymentSnapshotState => ({ status: "ready", classId: "class-1", outstanding: new Set(ids) });
const LOADING: PaymentSnapshotState = { status: "loading", classId: "class-1" };
const FAILED: PaymentSnapshotState = { status: "failed", classId: "class-1" };

/** A fake speechSynthesis that records speak / cancel calls in order. */
function fakeSpeech(voices: VoiceLike[] = [], options: { throwOnSpeak?: boolean } = {}) {
  const log: string[] = [];
  const spoken: UtteranceLike[] = [];
  const speech: SpeechLike = {
    speak(u) {
      if (options.throwOnSpeak) throw new Error("not allowed");
      log.push(`speak:${u.text}`);
      spoken.push(u);
    },
    cancel() {
      log.push("cancel");
    },
    getVoices: () => voices,
  };
  const createUtterance = (text: string): UtteranceLike => ({ text, lang: "", rate: 1, pitch: 1, volume: 1, voice: null, onerror: null });
  return { speech, createUtterance, log, spoken };
}

function fakeChime(log?: string[]) {
  let played = 0;
  let stopped = 0;
  return {
    chime: () => {
      played += 1;
      log?.push("chime");
      return () => {
        stopped += 1;
        log?.push("chime-stop");
      };
    },
    get played() {
      return played;
    },
    get stopped() {
      return stopped;
    },
  };
}

/** Fake audio elements: records play / pause per source; play() resolves or rejects as scripted. */
function fakeAudio(options: { reject?: boolean | ((src: string) => boolean); throwOnPlay?: boolean; log?: string[] } = {}) {
  const created: (AudioElementLike & { src: string; plays: number; pauses: number; released: boolean })[] = [];
  const log = options.log ?? [];
  const createAudio = (src: string) => {
    const element = {
      src,
      preload: "none",
      muted: false,
      currentTime: 0,
      plays: 0,
      pauses: 0,
      released: false,
      play() {
        if (options.throwOnPlay) throw new Error("NotSupportedError");
        element.plays += 1;
        log.push(`${element.muted ? "prime" : "play"}:${path.basename(src)}`);
        const reject = typeof options.reject === "function" ? options.reject(src) : options.reject;
        return reject ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
      },
      pause() {
        element.pauses += 1;
      },
      load() {
        log.push(`load:${path.basename(src)}`);
      },
      removeAttribute(name: string) {
        if (name === "src") element.released = true;
      },
    };
    created.push(element);
    return element;
  };
  return { createAudio, created, log, bySrc: (name: string) => created.find((e) => e.src.endsWith(name))! };
}

/** The panel's wiring (components/attendance/qr-scanner-panel.tsx) over fakes. */
function scannerWithAudio(responses: ScanSubmitOutcome[], options: { payment?: () => PaymentSnapshotState | null; rejectAudio?: boolean; throwOnPlay?: boolean } = {}) {
  const log: string[] = [];
  const { speech, createUtterance } = fakeSpeech();
  const speechLog = log;
  const recordingSpeech: SpeechLike = {
    speak: (u) => {
      speechLog.push(`speak:${u.text}`);
      speech.speak(u);
    },
    cancel: () => undefined,
    getVoices: () => [],
  };
  const chime = fakeChime(log);
  const audio = fakeAudio({ reject: options.rejectAudio, throwOnPlay: options.throwOnPlay, log });
  const announcer = createScanAnnouncer({ speech: recordingSpeech, createUtterance, chime: chime.chime, cues: createCuePlayer(audio.createAudio) });
  const announced = new Set<string>();
  let ids = 0;
  let submits = 0;
  const feedLengths: number[] = [];
  const queue = createScanQueue({
    lectureId: "lec-1",
    onChange: (s) => feedLengths.push(s.feed.length),
    newClientScanId: () => `client-scan-id-${String(++ids).padStart(4, "0")}`,
    sleep: async () => undefined,
    submit: async () => {
      submits += 1;
      return responses.shift() ?? fail(0, "NETWORK_ERROR");
    },
    onAnswered: (outcome) => {
      const feedback = scanFeedbackFor(outcome, announced, options.payment?.());
      if (!feedback) return;
      if (feedback.kind === "CUE") {
        announced.add(feedback.studentId);
        announcer.cue(feedback.cue);
      } else {
        announcer.say(feedback.text);
      }
    },
    onFailed: () => {
      announcer.say(SCAN_FEEDBACK_TEXT.FAILED);
    },
  });
  const sounds = () => log.filter((l) => l.startsWith("speak:") || l.startsWith("play:") || l === "chime");
  return { queue, announcer, log, sounds, audio, chime, submits: () => submits, feed: () => feedLengths[feedLengths.length - 1] ?? 0 };
}

const ACK = "play:attendance_card_acknowledgement.wav";
const WARN = "play:payment_warning.wav";
const say = (text: string) => `speak:${text}`;

// ---- Assets -------------------------------------------------------------------------------------------------

test("assets: both cue files exist in public/sounds and are valid PCM WAV files a browser can play", () => {
  for (const [cue, src] of Object.entries(SCAN_CUE_SOURCES)) {
    assert.match(src, /^\/sounds\/[a-z_]+\.wav$/, cue);
    const bytes = readFileSync(path.join(ROOT, "public", src));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF", src);
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE", src);
    assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, `${src}: RIFF size matches the file`);
    let offset = 12;
    let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
    let dataBytes = 0;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (id === "fmt ") {
        format = { audioFormat: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10), sampleRate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) };
      }
      if (id === "data") {
        assert.ok(offset + 8 + size <= bytes.length, `${src}: data chunk complete`);
        dataBytes = size;
      }
      offset += 8 + size + (size % 2);
    }
    assert.ok(format, `${src}: fmt chunk`);
    assert.equal(format!.audioFormat, 1, `${src}: PCM (universally supported)`);
    assert.ok([1, 2].includes(format!.channels) && [8, 16].includes(format!.bits) && format!.sampleRate >= 8000, `${src}: ${JSON.stringify(format)}`);
    const seconds = dataBytes / (format!.sampleRate * format!.channels * (format!.bits / 8));
    assert.ok(seconds > 0.1 && seconds < 3, `${src}: a short cue (${seconds.toFixed(2)} s)`);
  }
  assert.equal(SCAN_CUE_SOURCES.ACKNOWLEDGEMENT, "/sounds/attendance_card_acknowledgement.wav");
  assert.equal(SCAN_CUE_SOURCES.PAYMENT_WARNING, "/sounds/payment_warning.wav");
  const middleware = readFileSync(path.join(ROOT, "middleware.ts"), "utf8");
  assert.doesNotMatch(middleware, /["']\/sounds/, "static sounds are not behind the auth middleware");
});

// ---- What to play (pure) ----------------------------------------------------------------------------------

test("shouldAnnounceScan: only a new VALID STATUS_UPDATED (Present / Late) with a server-named student, once per student", () => {
  const none = new Set<string>();
  assert.equal(shouldAnnounceScan(answer(), none), true);
  assert.equal(shouldAnnounceScan(answer({ attendance: { status: "LATE", statusSource: "AUTO", pendingReview: false } }), none), true);
  assert.equal(shouldAnnounceScan(answer(), new Set(["stu-1"])), false, "already announced for this student");
  for (const effect of ["DUPLICATE", "EVIDENCE_ONLY", "REVIEW_REQUIRED", "RECORDED_ONLY", "NONE"]) {
    assert.equal(shouldAnnounceScan(answer({ effect }), none), false, effect);
  }
  for (const result of ["NOT_ELIGIBLE", "ELIGIBILITY_UNKNOWN", "INVALID_QR", "QR_UNVERIFIABLE", "WRONG_TEACHER", "LECTURE_UNAVAILABLE"]) {
    assert.equal(shouldAnnounceScan(answer({ result }), none), false, result);
  }
  assert.equal(shouldAnnounceScan(answer({ attendance: { status: "ABSENT", statusSource: "AUTO", pendingReview: false } }), none), false);
  assert.equal(shouldAnnounceScan(answer({ student: null }), none), false);
  assert.equal(shouldAnnounceScan(answer({ attendance: null }), none), false);
  assert.equal(shouldAnnounceScan(answer({ student: { studentId: "s", name: "  \u0007 ", registrationNumber: null } }), none), false, "no usable name");
  assert.equal(spokenName("  Manori\n\tJayasinghe \u0000"), "Manori Jayasinghe");
  assert.equal(spokenName("x".repeat(200)).length, 80);
});

test("new mark: the READY snapshot decides by the server's studentId; loading / failed / none → the neutral chime", () => {
  assert.equal(cueForNewMark("stu-1", ready([])), "ACKNOWLEDGEMENT");
  assert.equal(cueForNewMark("stu-1", ready(["stu-2"])), "ACKNOWLEDGEMENT");
  assert.equal(cueForNewMark("stu-1", ready(["stu-1"])), "PAYMENT_WARNING");
  assert.equal(cueForNewMark("stu-1", LOADING), "CHIME");
  assert.equal(cueForNewMark("stu-1", FAILED), "CHIME");
  assert.equal(cueForNewMark("stu-1", { status: "idle", classId: null }), "CHIME");
  assert.equal(cueForNewMark("stu-1", null), "CHIME");
  assert.equal(cueForNewMark("stu-1", undefined), "CHIME");

  const none = new Set<string>();
  assert.deepEqual(scanFeedbackFor(answer(), none, ready([])), { kind: "CUE", cue: "ACKNOWLEDGEMENT", studentId: "stu-1" });
  assert.deepEqual(scanFeedbackFor(answer(), none, ready(["stu-1"])), { kind: "CUE", cue: "PAYMENT_WARNING", studentId: "stu-1" });
  assert.deepEqual(scanFeedbackFor(answer(), none, LOADING), { kind: "CUE", cue: "CHIME", studentId: "stu-1" });
  assert.deepEqual(scanFeedbackFor(answer(), none, FAILED), { kind: "CUE", cue: "CHIME", studentId: "stu-1" });
  assert.equal(scanFeedbackFor(answer(), new Set(["stu-1"]), ready(["stu-1"])), null, "once per student: no second cue");
});

test("other answers: DUPLICATE / EVIDENCE_ONLY 'Already marked', REVIEW_REQUIRED 'Attendance requires review', refused 'Attendance failed'", () => {
  const none = new Set<string>();
  const speech = (text: string) => ({ kind: "SPEECH", text });
  assert.deepEqual(scanFeedbackFor(answer({ effect: "DUPLICATE" }), none, ready(["stu-1"])), speech("Already marked"));
  assert.deepEqual(scanFeedbackFor(answer({ effect: "EVIDENCE_ONLY" }), none, ready([])), speech("Already marked"));
  assert.deepEqual(scanFeedbackFor(answer({ effect: "REVIEW_REQUIRED" }), none, LOADING), speech("Attendance requires review"));
  for (const result of ["NOT_ELIGIBLE", "ELIGIBILITY_UNKNOWN", "INVALID_QR", "QR_UNVERIFIABLE", "WRONG_TEACHER", "LECTURE_UNAVAILABLE"]) {
    assert.deepEqual(scanFeedbackFor(answer({ result, effect: "NONE", attendance: null }), none, ready([])), speech("Attendance failed"), result);
  }
  // Repeats are not limited (only new marks are once per student).
  const confirmed = new Set(["stu-1"]);
  assert.deepEqual(scanFeedbackFor(answer({ effect: "DUPLICATE" }), confirmed, null), speech("Already marked"));
  // Nothing changed after finalization: silent (the feed explains it).
  assert.equal(scanFeedbackFor(answer({ effect: "RECORDED_ONLY", attendance: null }), none, ready([])), null);
  assert.deepEqual(SCAN_FEEDBACK_TEXT, { ALREADY_MARKED: "Already marked", REVIEW_REQUIRED: "Attendance requires review", FAILED: "Attendance failed" });
});

// ---- Through the queue ------------------------------------------------------------------------------------

test("normal acknowledgement: a new mark of a student with no outstanding balance (ready snapshot)", async () => {
  const s = scannerWithAudio([ok(answer())], { payment: () => ready(["stu-other"]) });
  s.queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle();
  assert.deepEqual(s.sounds(), [ACK]);
  s.queue.dispose();
});

test("payment warning: a new mark of a student in the outstanding Set; the id is the server's studentId, never the payload", async () => {
  const s = scannerWithAudio([ok(answer(student("stu-9")))], { payment: () => ready(["stu-9"]) });
  // The payload carries no student id at all.
  s.queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle();
  assert.deepEqual(s.sounds(), [WARN]);
  s.queue.dispose();
});

test("snapshot loading or failed: the neutral chime, never the acknowledgement (nothing is assumed paid)", async () => {
  for (const state of [LOADING, FAILED]) {
    const s = scannerWithAudio([ok(answer())], { payment: () => state });
    s.queue.enqueue("SLCQR1:payload-a", "MANUAL");
    await settle();
    assert.deepEqual(s.sounds(), ["chime"], state.status);
    s.queue.dispose();
  }
});

test("other answers through the queue: duplicate, evidence-only, review and refused scans speak their phrase", async () => {
  const s = scannerWithAudio(
    [
      ok(answer({ effect: "DUPLICATE" })),
      ok(answer({ effect: "EVIDENCE_ONLY" })),
      ok(answer({ effect: "REVIEW_REQUIRED" })),
      ok(answer({ result: "INVALID_QR", effect: "NONE", student: null, attendance: null })),
      ok(answer({ result: "NOT_ELIGIBLE", effect: "NONE", attendance: null })),
    ],
    { payment: () => ready([]) }
  );
  for (const p of ["a", "b", "c", "d", "e"]) {
    s.queue.enqueue(`SLCQR1:payload-${p}`, "MANUAL");
    await settle();
  }
  assert.deepEqual(s.sounds(), [say("Already marked"), say("Already marked"), say("Attendance requires review"), say("Attendance failed"), say("Attendance failed")]);
  s.queue.dispose();
});

test("terminal failures: 401, 409, 429, other HTTP errors and an exhausted no-answer each speak 'Attendance failed' once", async () => {
  for (const response of [fail(401, "UNAUTHORIZED"), fail(409, "ATTENDANCE_QR_CLOSED"), fail(429, "ATTENDANCE_SCAN_RATE_LIMITED"), fail(500, "INTERNAL_SERVER_ERROR"), fail(404, "LECTURE_NOT_FOUND"), fail(200, "INVALID_RESPONSE")]) {
    const s = scannerWithAudio([response]);
    s.queue.enqueue("SLCQR1:payload-a", "MANUAL");
    await settle();
    assert.deepEqual(s.sounds(), [say("Attendance failed")], response.result.ok ? "" : response.result.code);
    s.queue.dispose();
  }
});

test("no failure announcement while retrying: network failures are retried silently; only the final outcome is announced", async () => {
  const attempts = SCAN_QUEUE_LIMITS.networkAttempts;
  assert.ok(attempts >= 2);
  // Unanswered, then answered on the last automatic attempt: only the success cue.
  const recovered = scannerWithAudio([...Array.from({ length: attempts - 1 }, () => fail(0, "NETWORK_ERROR")), ok(answer())], { payment: () => ready([]) });
  recovered.queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle(60);
  assert.equal(recovered.submits(), attempts);
  assert.deepEqual(recovered.sounds(), [ACK]);
  recovered.queue.dispose();

  // Every automatic attempt unanswered: exactly one 'Attendance failed', after the last one.
  const exhausted = scannerWithAudio(Array.from({ length: attempts }, () => fail(0, "NETWORK_ERROR")));
  const spokenAt: number[] = [];
  const originalSay = exhausted.announcer.say;
  exhausted.announcer.say = (text: string) => {
    spokenAt.push(exhausted.submits());
    return originalSay(text);
  };
  exhausted.queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle(60);
  assert.equal(exhausted.submits(), attempts);
  assert.deepEqual(spokenAt, [attempts], "announced once, only after the last automatic attempt");
  assert.deepEqual(exhausted.sounds(), [say("Attendance failed")]);
  exhausted.queue.dispose();
});

test("the failure callback fires only after the scan is in the feed and never while it is pending; a throwing callback never breaks the queue", async () => {
  const order: string[] = [];
  let ids = 0;
  let pendingAtFailure = -1;
  let feedAtFailure = -1;
  let submits = 0;
  let last = { pending: 0, feed: 0 };
  const queue: ReturnType<typeof createScanQueue> = createScanQueue({
    lectureId: "lec-1",
    onChange: (s) => {
      last = { pending: s.pending.length, feed: s.feed.length };
    },
    newClientScanId: () => `client-scan-id-${String(++ids).padStart(4, "0")}`,
    sleep: async () => {
      order.push("retry-wait");
    },
    submit: async () => {
      submits += 1;
      order.push("submit");
      return submits <= SCAN_QUEUE_LIMITS.networkAttempts ? fail(0, "NETWORK_ERROR") : fail(409, "ATTENDANCE_QR_CLOSED");
    },
    onAnswered: () => order.push("answered"),
    onFailed: (error) => {
      order.push(`failed:${error.code}`);
      const now = queue.snapshot();
      pendingAtFailure = now.pending.length;
      feedAtFailure = now.feed.length;
      throw new Error("audio broke");
    },
  });
  queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle(60);
  const expected = [...Array.from({ length: SCAN_QUEUE_LIMITS.networkAttempts - 1 }, () => ["submit", "retry-wait"]).flat(), "submit", "failed:NETWORK_ERROR"];
  assert.deepEqual(order, expected);
  assert.equal(feedAtFailure, 1, "the failed scan is already shown");
  assert.equal(pendingAtFailure, 0, "no longer pending: it will not be retried");
  queue.enqueue("SLCQR1:payload-b", "MANUAL");
  await settle();
  assert.deepEqual(order.slice(-2), ["submit", "failed:ATTENDANCE_QR_CLOSED"], "the queue still works after a throwing callback");
  assert.equal(last.feed, 2);
  queue.dispose();
});

test("repeat rules: phrases for every distinct scan; cues once per successful attendance; the 5-second camera filter still applies", async () => {
  let clock = 1_000_000;
  const s = scannerWithAudio(
    [
      ok(answer()), // new mark
      ok(answer({ effect: "DUPLICATE" })),
      ok(answer({ effect: "DUPLICATE" })),
      ok(answer({ effect: "REVIEW_REQUIRED" })),
      ok(answer({ effect: "REVIEW_REQUIRED" })),
      fail(409, "ATTENDANCE_QR_CLOSED"),
      fail(409, "ATTENDANCE_QR_CLOSED"),
      ok(answer({ effect: "STATUS_UPDATED" })), // same student again (e.g. LATE -> PRESENT): no second cue
      ok(answer(student("stu-2"))), // another student: their own cue
    ],
    { payment: () => ready(["stu-2"]) }
  );
  for (const p of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
    s.queue.enqueue(`SLCQR1:payload-${p}`, "MANUAL");
    await settle();
  }
  assert.deepEqual(s.sounds(), [
    ACK,
    say("Already marked"),
    say("Already marked"),
    say("Attendance requires review"),
    say("Attendance requires review"),
    say("Attendance failed"),
    say("Attendance failed"),
    WARN,
  ]);
  s.queue.dispose();

  // Camera: the same code again within 5 s is ignored (no request, no sound); after 5 s it is a new scan.
  const camera = createScanQueue({
    lectureId: "lec-1",
    onChange: () => undefined,
    newClientScanId: () => `client-scan-id-${String(clock).padStart(16, "0")}`,
    sleep: async () => undefined,
    now: () => clock,
    submit: async () => ok(answer({ effect: "DUPLICATE" })),
  });
  assert.equal(SCAN_QUEUE_LIMITS.cameraRepeatMs, 5_000);
  assert.equal(camera.enqueue("SLCQR1:payload-a", "CAMERA"), "QUEUED");
  await settle();
  clock += 4_000;
  assert.equal(camera.enqueue("SLCQR1:payload-a", "CAMERA"), "DUPLICATE");
  clock += 1_500;
  assert.equal(camera.enqueue("SLCQR1:payload-a", "CAMERA"), "QUEUED");
  camera.dispose();
});

test("audio playback rejected (autoplay) or throwing: attendance continues; every scan is sent, answered and shown", async () => {
  for (const options of [{ rejectAudio: true }, { throwOnPlay: true }]) {
    const s = scannerWithAudio([ok(answer()), ok(answer(student("stu-2"))), ok(answer({ effect: "DUPLICATE" }))], { payment: () => ready(["stu-2"]), ...options });
    s.queue.enqueue("SLCQR1:payload-a", "MANUAL");
    s.queue.enqueue("SLCQR1:payload-b", "MANUAL");
    s.queue.enqueue("SLCQR1:payload-c", "MANUAL");
    await settle(60);
    assert.equal(s.submits(), 3, JSON.stringify(options));
    assert.equal(s.feed(), 3);
    assert.ok(s.log.includes(say("Already marked")), "speech still works");
    s.queue.dispose();
  }
});

test("a throwing onAnswered (audio problem) never breaks the queue: every scan is still sent, answered and shown", async () => {
  let ids = 0;
  let submits = 0;
  let feedLength = 0;
  const queue = createScanQueue({
    lectureId: "lec-1",
    onChange: (snapshot) => {
      feedLength = snapshot.feed.length;
    },
    newClientScanId: () => `client-scan-id-${String(++ids).padStart(4, "0")}`,
    sleep: async () => undefined,
    submit: async () => {
      submits += 1;
      return ok(answer());
    },
    onAnswered: () => {
      throw new Error("audio failed");
    },
  });
  queue.enqueue("SLCQR1:payload-a", "MANUAL");
  queue.enqueue("SLCQR1:payload-b", "MANUAL");
  await settle();
  assert.equal(submits, 2);
  assert.equal(feedLength, 2);
  queue.dispose();
});

test("no payment request per scan: the snapshot is fetched once; scans only read it", async () => {
  let fetches = 0;
  const snapshot = createPaymentSnapshot({
    onChange: () => undefined,
    fetchOutstanding: async () => {
      fetches += 1;
      return { ok: true, status: 200, data: { studentIds: ["stu-2"] } };
    },
  });
  await snapshot.load("class-1");
  const s = scannerWithAudio([ok(answer()), ok(answer(student("stu-2"))), ok(answer({ effect: "DUPLICATE" }))], { payment: () => snapshot.current() });
  for (const p of ["a", "b", "c"]) {
    s.queue.enqueue(`SLCQR1:payload-${p}`, "MANUAL");
    await settle();
  }
  assert.equal(fetches, 1);
  assert.deepEqual(s.sounds(), [ACK, WARN, say("Already marked")]);
  s.queue.dispose();
  snapshot.dispose();
});

// ---- The cue player and the announcer -------------------------------------------------------------------------

test("cue player: two elements created once (preload auto) and reused; each play stops both first and rewinds", () => {
  const audio = fakeAudio();
  const player = createCuePlayer(audio.createAudio);
  assert.equal(audio.created.length, 2);
  assert.deepEqual(audio.created.map((e) => e.src).sort(), [SCAN_CUE_SOURCES.ACKNOWLEDGEMENT, SCAN_CUE_SOURCES.PAYMENT_WARNING].sort());
  assert.ok(audio.created.every((e) => e.preload === "auto"));
  for (let i = 0; i < 5; i += 1) {
    assert.equal(player.play("ACKNOWLEDGEMENT"), true);
    assert.equal(player.play("PAYMENT_WARNING"), true);
  }
  assert.equal(audio.created.length, 2, "no new element per scan");
  assert.equal(audio.bySrc("attendance_card_acknowledgement.wav").plays, 5);
  assert.equal(audio.bySrc("payment_warning.wav").plays, 5);
  assert.ok(audio.created.every((e) => e.pauses >= 10), "every play pauses both elements first (no overlap)");
  audio.created[0].currentTime = 0.3;
  player.play("PAYMENT_WARNING");
  assert.equal(audio.created[0].currentTime, 0, "rewound");
  // No audio support at all: silent, never throws.
  const none = createCuePlayer(() => null);
  assert.equal(none.play("ACKNOWLEDGEMENT"), false);
  const throwing = createCuePlayer(() => {
    throw new Error("no Audio");
  });
  assert.equal(throwing.play("PAYMENT_WARNING"), false);
});

test("autoplay: a rejected play() is swallowed; unlock() primes both elements muted during a gesture, then restores them", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const blocked = fakeAudio({ reject: true });
    const player = createCuePlayer(blocked.createAudio);
    assert.equal(player.play("ACKNOWLEDGEMENT"), true);
    player.unlock();
    await settle();
    assert.ok(blocked.log.includes("prime:attendance_card_acknowledgement.wav"));
    assert.ok(blocked.created.every((e) => e.muted === false), "never left muted");
    // A failed unlock may be tried again on the next gesture.
    player.unlock();
    await settle();
    assert.equal(blocked.log.filter((l) => l.startsWith("prime:")).length, 4);

    const allowed = fakeAudio();
    const unlocked = createCuePlayer(allowed.createAudio);
    unlocked.unlock();
    await settle();
    assert.ok(allowed.created.every((e) => e.muted === false && e.pauses >= 1 && e.currentTime === 0), "primed silently and rewound");
    unlocked.unlock();
    await settle();
    assert.equal(allowed.log.filter((l) => l.startsWith("prime:")).length, 2, "unlocked once");
    assert.equal(unlocked.play("PAYMENT_WARNING"), true);
    assert.equal(allowed.bySrc("payment_warning.wav").muted, false, "real cues are audible");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, [], "no unhandled rejections");
});

test("unlock never silences a real cue that started during it", async () => {
  const audio = fakeAudio();
  const player = createCuePlayer(audio.createAudio);
  player.unlock();
  player.play("ACKNOWLEDGEMENT");
  const ack = audio.bySrc("attendance_card_acknowledgement.wav");
  const pausesAfterPlay = ack.pauses;
  await settle();
  assert.equal(ack.pauses, pausesAfterPlay, "the cue keeps playing");
  assert.equal(ack.muted, false);
});

test("no overlap: every cue, chime or phrase first silences speech, the chime and both cue elements", () => {
  const log: string[] = [];
  const speech: SpeechLike = { speak: (u) => log.push(`speak:${u.text}`), cancel: () => log.push("cancel"), getVoices: () => [] };
  const chime = fakeChime(log);
  const cues = { play: (cue: string) => (log.push(`cue:${cue}`), true), stop: () => log.push("cues-stop"), unlock: () => undefined, dispose: () => undefined };
  const announcer = createScanAnnouncer({ speech, createUtterance: fakeSpeech().createUtterance, chime: chime.chime, cues });
  announcer.cue("ACKNOWLEDGEMENT");
  announcer.cue("CHIME");
  announcer.say("Already marked");
  announcer.cue("PAYMENT_WARNING");
  assert.deepEqual(log, [
    "cancel",
    "cues-stop",
    "cue:ACKNOWLEDGEMENT",
    "cancel",
    "cues-stop",
    "chime",
    "cancel",
    "chime-stop",
    "cues-stop",
    "speak:Already marked",
    "cancel",
    "cues-stop",
    "cue:PAYMENT_WARNING",
  ]);
});

test("speech: natural rate, pitch and volume; the chosen voice and its language; no speech → silent (no misleading chime)", () => {
  const { speech, createUtterance, spoken } = fakeSpeech([{ name: "Microsoft Sonia Online - English (United Kingdom)", lang: "en-GB" }]);
  const chime = fakeChime();
  const announcer = createScanAnnouncer({ speech, createUtterance, chime: chime.chime });
  assert.equal(announcer.say("Attendance failed"), "SPOKEN");
  const u = spoken[0];
  assert.equal(u.text, "Attendance failed");
  assert.equal(u.voice?.name, "Microsoft Sonia Online - English (United Kingdom)");
  assert.equal(u.lang, "en-GB");
  assert.deepEqual([u.rate, u.pitch, u.volume], [ANNOUNCEMENT_VOICE_SETTINGS.rate, ANNOUNCEMENT_VOICE_SETTINGS.pitch, ANNOUNCEMENT_VOICE_SETTINGS.volume]);
  u.onerror?.({ error: "synthesis-failed" });
  assert.equal(chime.played, 0, "the chime means 'marked, payment unknown': never used for a phrase");

  const noSpeech = fakeChime();
  assert.equal(createScanAnnouncer({ speech: null, chime: noSpeech.chime }).say("Already marked"), "NONE");
  const t = fakeSpeech([], { throwOnSpeak: true });
  assert.equal(createScanAnnouncer({ speech: t.speech, createUtterance: t.createUtterance, chime: noSpeech.chime }).say("Already marked"), "NONE");
  assert.equal(noSpeech.played, 0);
  assert.equal(createScanAnnouncer({}).cue("CHIME"), "NONE", "nothing available: silent, no error");
  assert.equal(createScanAnnouncer({}).cue("ACKNOWLEDGEMENT"), "NONE");
});

test("voice: a female-sounding English voice is preferred (British English first); otherwise any English voice; none -> default", () => {
  const voices: VoiceLike[] = [
    { name: "Microsoft David - English (United States)", lang: "en-US" },
    { name: "Google Deutsch", lang: "de-DE" },
    { name: "Microsoft Zira - English (United States)", lang: "en-US" },
    { name: "Google UK English Female", lang: "en-GB" },
    { name: "Google UK English Male", lang: "en-GB" },
  ];
  assert.equal(pickAnnouncementVoice(voices)?.name, "Google UK English Female");
  assert.equal(pickAnnouncementVoice(voices.filter((v) => v.lang !== "en-GB"))?.name, "Microsoft Zira - English (United States)");
  assert.equal(pickAnnouncementVoice([{ name: "Daniel", lang: "en-GB" }, { name: "Some Voice", lang: "en_AU" }])?.name, "Some Voice", "a voice not known to be male before a male one");
  assert.equal(pickAnnouncementVoice([{ name: "Google Deutsch", lang: "de-DE" }]), null);
  assert.equal(pickAnnouncementVoice([]), null);
});

test("cleanup: dispose silences everything, releases both audio elements and ends all feedback", () => {
  const log: string[] = [];
  const chime = fakeChime(log);
  const audio = fakeAudio({ log });
  const { speech, createUtterance } = fakeSpeech();
  const announcer = createScanAnnouncer({ speech, createUtterance, chime: chime.chime, cues: createCuePlayer(audio.createAudio) });
  announcer.cue("CHIME");
  announcer.cue("ACKNOWLEDGEMENT");
  announcer.dispose();
  assert.ok(audio.created.every((e) => e.released), "sources released");
  assert.ok(log.includes("load:attendance_card_acknowledgement.wav") && log.includes("load:payment_warning.wav"));
  assert.equal(chime.stopped, 1);
  const plays = audio.created.reduce((n, e) => n + e.plays, 0);
  assert.equal(announcer.cue("PAYMENT_WARNING"), "NONE");
  assert.equal(announcer.cue("CHIME"), "NONE");
  assert.equal(announcer.say("Attendance failed"), "NONE");
  announcer.unlock();
  assert.equal(audio.created.reduce((n, e) => n + e.plays, 0), plays, "nothing plays after dispose");
  assert.equal(chime.played, 1);
  announcer.dispose(); // idempotent
});

// ---- The panel's wiring (source) ----------------------------------------------------------------------------

test("panel: one announcer per scanner, fed only by server answers and terminal failures, unlocked by user gestures, disposed on unmount", () => {
  const panel = readFileSync(path.join(ROOT, "components", "attendance", "qr-scanner-panel.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.equal((panel.match(/createBrowserScanAnnouncer\(\)/g) ?? []).length, 1);
  assert.match(panel, /const announcer = createBrowserScanAnnouncer\(\);/);
  assert.match(
    panel,
    /onAnswered: \(outcome\) => \{\s*const feedback = scanFeedbackFor\(outcome, announced, paymentRef\.current\?\.current\(\)\);\s*if \(!feedback\) return;\s*if \(feedback\.kind === "CUE"\) \{\s*announced\.add\(feedback\.studentId\);\s*announcer\.cue\(feedback\.cue\);\s*\} else \{\s*announcer\.say\(feedback\.text\);\s*\}\s*\},/
  );
  assert.match(panel, /onFailed: \(\) => \{\s*announcer\.say\(SCAN_FEEDBACK_TEXT\.FAILED\);\s*\},/);
  assert.match(panel, /const AUDIO_UNLOCK_EVENTS = \["pointerdown", "keydown", "touchend", "click"\] as const;/);
  assert.match(panel, /const onUserGesture = \(\) => announcer\.unlock\(\);/);
  assert.match(panel, /for \(const type of AUDIO_UNLOCK_EVENTS\) window\.addEventListener\(type, onUserGesture, true\);/);
  const cleanup = panel.slice(panel.indexOf("    return () => {\n      window.removeEventListener(\"pagehide\""), panel.indexOf("}, [lectureId, load, showHint]);"));
  assert.ok(cleanup.includes("for (const type of AUDIO_UNLOCK_EVENTS) window.removeEventListener(type, onUserGesture, true);"));
  assert.ok(cleanup.includes("announcer.dispose();"));
  assert.doesNotMatch(panel, /announcer\.announce\(|Attendance marked for/, "the spoken name confirmation is gone");

  const audio = readFileSync(path.join(ROOT, "components", "attendance", "scan-audio.ts"), "utf8");
  assert.doesNotMatch(audio, /fetch\(|https?:\/\/|XMLHttpRequest/, "no network");
  assert.equal((audio.match(/new AudioCtor\(/g) ?? []).length, 1, "audio elements only in the cue player factory");
  for (const m of audio.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
    assert.ok(m[1], `type-only import: ${m[2]}`);
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /speech|tts|audio|howler|tone/i.test(d)), "no new dependency");
});
