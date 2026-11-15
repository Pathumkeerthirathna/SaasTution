/**
 * QR attendance scanner: spoken confirmation of a NEW attendance mark
 * (components/attendance/scan-audio.ts) and its wiring through the scan
 * queue's onAnswered (components/attendance/qr-scanner-logic.ts) into the
 * panel. Fakes only: a fake speechSynthesis / utterance, a fake chime, a
 * scripted submit. No browser, no audio device.
 *
 *   npm run test:attendance-ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createScanQueue, type QrScanResponse, type ScanSubmitOutcome } from "../../components/attendance/qr-scanner-logic";
import {
  ANNOUNCEMENT_VOICE_SETTINGS,
  announcementText,
  createScanAnnouncer,
  pickAnnouncementVoice,
  shouldAnnounceScan,
  spokenName,
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
const ok = (data: QrScanResponse): ScanSubmitOutcome => ({ result: { ok: true, status: 200, data }, retryAfterSeconds: null });
const fail = (status: number, code: string): ScanSubmitOutcome => ({ result: { ok: false, status, code, message: "safe message" }, retryAfterSeconds: null });

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

function fakeChime() {
  let played = 0;
  let stopped = 0;
  return {
    chime: () => {
      played += 1;
      return () => {
        stopped += 1;
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

// ---- When to announce ---------------------------------------------------------------------------------------

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
  assert.equal(shouldAnnounceScan(answer({ student: { studentId: "s", name: "  \u0007 ", registrationNumber: null } }), none), false, "no speakable name");
});

test("the text: 'Attendance marked for <name>.' with the server's name (control characters removed, bounded)", () => {
  assert.equal(announcementText("Manori Jayasinghe"), "Attendance marked for Manori Jayasinghe.");
  assert.equal(spokenName("  Manori\n\tJayasinghe \u0000"), "Manori Jayasinghe");
  assert.equal(spokenName("x".repeat(200)).length, 80);
});

// ---- Through the queue (tests 10-12) ----------------------------------------------------------------------

function scannerWithAudio(responses: ScanSubmitOutcome[]) {
  const { speech, createUtterance, log } = fakeSpeech();
  const announcer = createScanAnnouncer({ speech, createUtterance, chime: () => undefined });
  const announced = new Set<string>();
  let ids = 0;
  const queue = createScanQueue({
    lectureId: "lec-1",
    onChange: () => undefined,
    newClientScanId: () => `client-scan-id-${String(++ids).padStart(4, "0")}`,
    sleep: async () => undefined,
    submit: async () => responses.shift() ?? fail(0, "NETWORK_ERROR"),
    // Exactly the panel's wiring (components/attendance/qr-scanner-panel.tsx).
    onAnswered: (outcome) => {
      if (!outcome.student || !shouldAnnounceScan(outcome, announced)) return;
      announced.add(outcome.student.studentId);
      announcer.announce(outcome.student.name);
    },
  });
  const spokenTexts = () => log.filter((l) => l.startsWith("speak:")).map((l) => l.slice(6));
  return { queue, spokenTexts };
}

test("10. a successful NEW scan triggers exactly one announcement, with the server's name", async () => {
  const { queue, spokenTexts } = scannerWithAudio([ok(answer())]);
  // The payload carries no name at all: the spoken name can only come from the server's answer.
  queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle();
  assert.deepEqual(spokenTexts(), ["Attendance marked for Manori Jayasinghe."]);
  queue.dispose();
});

test("11. a duplicate scan (server: DUPLICATE, or the same student again) never announces success again", async () => {
  const { queue, spokenTexts } = scannerWithAudio([
    ok(answer()),
    ok(answer({ effect: "DUPLICATE" })),
    ok(answer({ effect: "STATUS_UPDATED" })), // e.g. an earlier QR time moved LATE -> PRESENT: same student, not announced twice
  ]);
  queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle();
  queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle();
  queue.enqueue("SLCQR1:payload-a", "MANUAL");
  await settle();
  assert.equal(spokenTexts().length, 1);
  queue.dispose();
});

test("12. a failed scan (refused, HTTP error, no answer) never plays success audio; another student is announced independently", async () => {
  const { queue, spokenTexts } = scannerWithAudio([
    ok(answer({ result: "NOT_ELIGIBLE", effect: "NONE", attendance: null })),
    ok(answer({ result: "INVALID_QR", effect: "NONE", student: null, attendance: null })),
    fail(409, "ATTENDANCE_QR_CLOSED"),
    fail(429, "ATTENDANCE_SCAN_RATE_LIMITED"),
    fail(0, "NETWORK_ERROR"),
    fail(0, "NETWORK_ERROR"),
    fail(0, "NETWORK_ERROR"),
    ok(answer({ student: { studentId: "stu-2", name: "Kasun Silva", registrationNumber: null } })),
  ]);
  for (const p of ["a", "b", "c", "d", "e", "f"]) {
    queue.enqueue(`SLCQR1:payload-${p}`, "MANUAL");
    await settle();
  }
  assert.deepEqual(spokenTexts(), ["Attendance marked for Kasun Silva."]);
  queue.dispose();
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

// ---- The announcer ----------------------------------------------------------------------------------------

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

test("speech: natural rate, pitch and volume; the chosen voice and its language", () => {
  const { speech, createUtterance, spoken } = fakeSpeech([{ name: "Microsoft Sonia Online - English (United Kingdom)", lang: "en-GB" }]);
  const chime = fakeChime();
  const announcer = createScanAnnouncer({ speech, createUtterance, chime: chime.chime });
  assert.equal(announcer.announce("Manori Jayasinghe"), "SPOKEN");
  const u = spoken[0];
  assert.equal(u.text, "Attendance marked for Manori Jayasinghe.");
  assert.equal(u.voice?.name, "Microsoft Sonia Online - English (United Kingdom)");
  assert.equal(u.lang, "en-GB");
  assert.deepEqual([u.rate, u.pitch, u.volume], [ANNOUNCEMENT_VOICE_SETTINGS.rate, ANNOUNCEMENT_VOICE_SETTINGS.pitch, ANNOUNCEMENT_VOICE_SETTINGS.volume]);
  assert.ok(u.rate >= 0.85 && u.rate <= 1.05 && u.volume <= 1);
  assert.equal(chime.played, 0, "no chime when speech works");
});

test("overlap: each announcement cancels the previous one first (rapid scans never queue speech up)", () => {
  const { speech, createUtterance, log } = fakeSpeech();
  const announcer = createScanAnnouncer({ speech, createUtterance });
  announcer.announce("A One");
  announcer.announce("B Two");
  announcer.announce("C Three");
  assert.deepEqual(log, [
    "cancel",
    "speak:Attendance marked for A One.",
    "cancel",
    "speak:Attendance marked for B Two.",
    "cancel",
    "speak:Attendance marked for C Three.",
  ]);
});

test("fallback chime: no speech synthesis, or speak() throws, or the utterance errors (not our own cancel)", () => {
  const noSpeech = fakeChime();
  assert.equal(createScanAnnouncer({ speech: null, chime: noSpeech.chime }).announce("A"), "CHIME");
  assert.equal(noSpeech.played, 1);

  const throws = fakeChime();
  const t = fakeSpeech([], { throwOnSpeak: true });
  assert.equal(createScanAnnouncer({ speech: t.speech, createUtterance: t.createUtterance, chime: throws.chime }).announce("A"), "CHIME");
  assert.equal(throws.played, 1);

  const errored = fakeChime();
  const e = fakeSpeech();
  createScanAnnouncer({ speech: e.speech, createUtterance: e.createUtterance, chime: errored.chime }).announce("A");
  e.spoken[0].onerror?.({ error: "interrupted" });
  e.spoken[0].onerror?.({ error: "canceled" });
  assert.equal(errored.played, 0, "our own cancel is not a failure");
  e.spoken[0].onerror?.({ error: "synthesis-failed" });
  assert.equal(errored.played, 1);

  assert.equal(createScanAnnouncer({ speech: null }).announce("A"), "NONE", "nothing available: silent, no error");
});

test("chime overlap and dispose: a new announcement stops a chime still sounding; dispose silences and ends announcing", () => {
  const chime = fakeChime();
  const announcer = createScanAnnouncer({ speech: null, chime: chime.chime });
  announcer.announce("A");
  announcer.announce("B");
  assert.deepEqual([chime.played, chime.stopped], [2, 1]);
  announcer.dispose();
  assert.equal(chime.stopped, 2);
  assert.equal(announcer.announce("C"), "NONE");
  assert.equal(chime.played, 2);
});

// ---- The panel's wiring (source) ----------------------------------------------------------------------------

test("panel: one announcer per scanner, fed only by server answers (onAnswered), disposed on unmount; no new dependency", () => {
  const panel = readFileSync(path.join(ROOT, "components", "attendance", "qr-scanner-panel.tsx"), "utf8");
  assert.match(panel, /const announcer = createBrowserScanAnnouncer\(\);/);
  assert.match(panel, /onAnswered: \(outcome\) => \{\s*if \(!outcome\.student \|\| !shouldAnnounceScan\(outcome, announced\)\) return;\s*announced\.add\(outcome\.student\.studentId\);\s*announcer\.announce\(outcome\.student\.name\);/);
  assert.match(panel, /announcer\.dispose\(\);/);
  const audio = readFileSync(path.join(ROOT, "components", "attendance", "scan-audio.ts"), "utf8");
  assert.doesNotMatch(audio, /fetch\(|new Audio\(|https?:\/\/|from "(?!@\/components\/attendance\/qr-scanner-logic)/, "no network, no audio files, no packages");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /speech|tts|audio|howler|tone/i.test(d)));
});
