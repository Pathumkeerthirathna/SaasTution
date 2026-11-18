/*
 * QR attendance scanner: audio feedback for each scan, on the teacher's
 * device only.
 *
 * WHAT is played is decided by scanFeedbackFor (pure), from the SERVER's
 * answer only (never anything read from the QR payload):
 *  - a NEW mark (shouldAnnounceScan: VALID + STATUS_UPDATED, PRESENT / LATE,
 *    once per student while this scanner is open) plays a cue chosen from
 *    the payment snapshot (components/attendance/payment-snapshot.ts) by the
 *    server's student.studentId: in the READY snapshot's outstanding Set →
 *    the payment warning; ready and not in it → the acknowledgement; loading,
 *    failed or no snapshot → the neutral two-note chime (never assumed paid);
 *  - DUPLICATE / EVIDENCE_ONLY → "Already marked"; REVIEW_REQUIRED →
 *    "Attendance requires review"; a refused answer (any result other than
 *    VALID) → "Attendance failed", every time;
 *  - a scan that finally failed without an answer (HTTP error, or no answer
 *    after the automatic retries; the queue's onFailed) → "Attendance failed".
 *
 * Cues are two preloaded WAV files (public/sounds), each one reused Audio
 * element; the chime uses the Web Audio API, speech the Web Speech API.
 * Everything is fire-and-forget: it never throws, never awaits anything the
 * scanner waits for, and never touches the camera or the queue. A rejected
 * play() (autoplay policy) is swallowed; unlock() (called on the teacher's
 * own clicks / key presses) primes the elements and the chime's context.
 *
 * Overlap: every new cue or phrase first stops whatever is still playing or
 * speaking, so rapid scans never queue up a backlog.
 */

import type { PaymentSnapshotState } from "@/components/attendance/payment-snapshot";
import type { QrScanResponse } from "@/components/attendance/qr-scanner-logic";

const MARKED_STATUSES = new Set(["PRESENT", "LATE"]);
const MAX_SPOKEN_NAME_LENGTH = 80;

/** Pure: is this answer a new mark to confirm? `announced` holds the student ids already confirmed. */
export function shouldAnnounceScan(outcome: QrScanResponse, announced: ReadonlySet<string>): boolean {
  if (outcome.result !== "VALID" || outcome.effect !== "STATUS_UPDATED") return false;
  if (!outcome.student || !outcome.attendance || !MARKED_STATUSES.has(outcome.attendance.status)) return false;
  if (spokenName(outcome.student.name) === "") return false;
  return !announced.has(outcome.student.studentId);
}

/** The name as it is shown / spoken: control characters removed, whitespace collapsed, bounded. */
export function spokenName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPOKEN_NAME_LENGTH);
}

// ---- What to play ------------------------------------------------------------------------------------------

export const SCAN_FEEDBACK_TEXT = {
  ALREADY_MARKED: "Already marked",
  REVIEW_REQUIRED: "Attendance requires review",
  FAILED: "Attendance failed",
} as const;

export type ScanCue = "ACKNOWLEDGEMENT" | "PAYMENT_WARNING" | "CHIME";

export type ScanFeedback =
  | { kind: "CUE"; cue: ScanCue; studentId: string }
  | { kind: "SPEECH"; text: (typeof SCAN_FEEDBACK_TEXT)[keyof typeof SCAN_FEEDBACK_TEXT] };

/** Pure: the cue for a new mark from the payment snapshot (only a READY snapshot decides). */
export function cueForNewMark(studentId: string, payment: PaymentSnapshotState | null | undefined): ScanCue {
  if (!payment || payment.status !== "ready") return "CHIME";
  return payment.outstanding.has(studentId) ? "PAYMENT_WARNING" : "ACKNOWLEDGEMENT";
}

/**
 * Pure: the feedback for one server answer, or null (silence). A new mark
 * already confirmed for this student (e.g. LATE improved to PRESENT) and
 * RECORDED_ONLY (after finalization: nothing changed) are silent.
 */
export function scanFeedbackFor(
  outcome: QrScanResponse,
  announced: ReadonlySet<string>,
  payment: PaymentSnapshotState | null | undefined
): ScanFeedback | null {
  if (outcome.result !== "VALID") return { kind: "SPEECH", text: SCAN_FEEDBACK_TEXT.FAILED };
  switch (outcome.effect) {
    case "STATUS_UPDATED":
      if (!outcome.student || !shouldAnnounceScan(outcome, announced)) return null;
      return { kind: "CUE", cue: cueForNewMark(outcome.student.studentId, payment), studentId: outcome.student.studentId };
    case "DUPLICATE":
    case "EVIDENCE_ONLY":
      return { kind: "SPEECH", text: SCAN_FEEDBACK_TEXT.ALREADY_MARKED };
    case "REVIEW_REQUIRED":
      return { kind: "SPEECH", text: SCAN_FEEDBACK_TEXT.REVIEW_REQUIRED };
    default:
      return null;
  }
}

// ---- Voice choice ------------------------------------------------------------------------------------------

export type VoiceLike = { name: string; lang: string; default?: boolean; localService?: boolean };

/** Names of commonly installed female English voices (Windows, macOS / iOS, Android / Chrome). */
const FEMALE_VOICE_NAME =
  /\b(female|woman|zira|aria|jenny|libby|sonia|natasha|clara|emma|ava|michelle|hazel|susan|heera|neerja|samantha|victoria|karen|moira|tessa|serena|fiona|veena|kate|allison|google uk english female)\b/i;
const MALE_VOICE_NAME = /\b(male|david|mark|george|guy|ryan|daniel|alex|fred|arthur|oliver|james|thomas|google uk english male)\b/i;

/**
 * The preferred voice: English, female-sounding by name, British / Indian /
 * Australian / US English first (any English otherwise); a local voice is
 * preferred over a network one. null = the browser's default voice.
 */
export function pickAnnouncementVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  if (english.length === 0) return null;
  const regionRank = (lang: string) => {
    const region = lang.toLowerCase().replace("_", "-");
    if (region.startsWith("en-gb")) return 0;
    if (region.startsWith("en-in")) return 1;
    if (region.startsWith("en-au")) return 2;
    if (region.startsWith("en-us")) return 3;
    return 4;
  };
  const score = (v: V) => {
    const female = FEMALE_VOICE_NAME.test(v.name) && !/\bmale\b/i.test(v.name.replace(/female/gi, ""));
    const male = !female && MALE_VOICE_NAME.test(v.name);
    return (female ? 0 : male ? 200 : 100) + regionRank(v.lang) * 10 + (v.localService === false ? 1 : 0);
  };
  return [...english].sort((a, b) => score(a) - score(b))[0] ?? null;
}

// ---- The cue player (two preloaded, reused audio elements) --------------------------------------------------

/** The cue files (public/sounds), served as static assets. */
export const SCAN_CUE_SOURCES = {
  ACKNOWLEDGEMENT: "/sounds/attendance_card_acknowledgement.wav",
  PAYMENT_WARNING: "/sounds/payment_warning.wav",
} as const;

export type FileCue = keyof typeof SCAN_CUE_SOURCES;

/** The parts of HTMLAudioElement used here (injectable for tests). */
export type AudioElementLike = {
  preload: string;
  muted: boolean;
  currentTime: number;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
};

/**
 * One element per cue, created once (preload "auto") and reused for every
 * scan. play() stops both first (no overlap); a rejected play() is
 * swallowed. unlock() primes both elements muted during a user gesture
 * (autoplay policies), at most once until it succeeds. dispose() stops them
 * and releases their sources.
 */
export function createCuePlayer(createAudio: (src: string) => AudioElementLike | null) {
  const elements = new Map<FileCue, AudioElementLike>();
  for (const cue of Object.keys(SCAN_CUE_SOURCES) as FileCue[]) {
    try {
      const element = createAudio(SCAN_CUE_SOURCES[cue]);
      if (!element) continue;
      element.preload = "auto";
      elements.set(cue, element);
    } catch {
      // no audio here: that cue stays silent
    }
  }
  let active: AudioElementLike | null = null;
  let unlocked = false;
  let unlocking = false;
  let disposed = false;

  const settle = (result: Promise<void> | void, onFailure: () => void, onSuccess?: () => void) => {
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(
        () => onSuccess?.(),
        () => onFailure()
      );
    } else {
      onSuccess?.();
    }
  };

  const stop = () => {
    active = null;
    for (const element of elements.values()) {
      try {
        element.pause();
        element.currentTime = 0;
      } catch {
        // ignore
      }
    }
  };

  return {
    /** true when playback was started (a later rejection is swallowed). */
    play(cue: FileCue): boolean {
      if (disposed) return false;
      stop();
      const element = elements.get(cue);
      if (!element) return false;
      try {
        element.muted = false;
        active = element;
        settle(element.play(), () => {
          if (active === element) active = null;
        });
        return true;
      } catch {
        active = null;
        return false;
      }
    },
    stop,
    unlock() {
      if (disposed || unlocked || unlocking) return;
      unlocking = true;
      let pending = elements.size;
      let failed = false;
      const done = () => {
        pending -= 1;
        if (pending > 0) return;
        unlocking = false;
        unlocked = !failed;
      };
      if (pending === 0) {
        unlocking = false;
        return;
      }
      for (const element of elements.values()) {
        try {
          element.muted = true;
          settle(
            element.play(),
            () => {
              failed = true;
              if (active !== element) element.muted = false;
              done();
            },
            () => {
              // A real cue started meanwhile keeps playing; otherwise rewind silently.
              if (active !== element) {
                try {
                  element.pause();
                  element.currentTime = 0;
                } catch {
                  // ignore
                }
              }
              element.muted = false;
              done();
            }
          );
        } catch {
          failed = true;
          element.muted = false;
          done();
        }
      }
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      for (const element of elements.values()) {
        try {
          element.removeAttribute("src");
          element.load();
        } catch {
          // ignore
        }
      }
      elements.clear();
    },
  };
}

export type CuePlayer = ReturnType<typeof createCuePlayer>;

// ---- The announcer ----------------------------------------------------------------------------------------

/** The parts of window.speechSynthesis used here (injectable for tests). */
export type SpeechLike = {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): VoiceLike[];
  speaking?: boolean;
  pending?: boolean;
};
export type UtteranceLike = {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  voice: VoiceLike | null;
  onerror: ((event: { error?: string }) => void) | null;
};

export type AnnouncerDeps = {
  /** null / undefined: no speech synthesis here (phrases are silent). */
  speech?: SpeechLike | null;
  createUtterance?: (text: string) => UtteranceLike;
  /** Plays the neutral two-note chime; returns a stop function. */
  chime?: () => (() => void) | void;
  /** The file cues (acknowledgement / payment warning). */
  cues?: Pick<CuePlayer, "play" | "stop" | "unlock" | "dispose"> | null;
  /** Prepares the chime during a user gesture (autoplay policies). */
  unlockChime?: () => void;
};

export const ANNOUNCEMENT_VOICE_SETTINGS = { rate: 0.95, pitch: 1, volume: 0.9 } as const;

/**
 * One announcer per scanner page. cue() plays a cue, say() speaks a fixed
 * phrase; each first silences anything still playing or speaking.
 * unlock() is for the teacher's own gestures; dispose() silences it and
 * releases the audio elements.
 */
export function createScanAnnouncer(deps: AnnouncerDeps) {
  let stopChime: (() => void) | null = null;
  let disposed = false;

  const silence = () => {
    try {
      deps.speech?.cancel();
    } catch {
      // ignore
    }
    if (stopChime) {
      try {
        stopChime();
      } catch {
        // ignore
      }
      stopChime = null;
    }
    try {
      deps.cues?.stop();
    } catch {
      // ignore
    }
  };

  const playChime = (): boolean => {
    if (!deps.chime) return false;
    try {
      stopChime = deps.chime() ?? null;
      return true;
    } catch {
      stopChime = null;
      return false;
    }
  };

  return {
    cue(cue: ScanCue): "PLAYED" | "CHIME" | "NONE" {
      if (disposed) return "NONE";
      silence();
      if (cue !== "CHIME") {
        try {
          if (deps.cues?.play(cue)) return "PLAYED";
        } catch {
          // silent
        }
        return "NONE";
      }
      return playChime() ? "CHIME" : "NONE";
    },
    say(text: string): "SPOKEN" | "NONE" {
      if (disposed) return "NONE";
      silence();
      const speech = deps.speech;
      if (!speech || !deps.createUtterance) return "NONE";
      try {
        const utterance = deps.createUtterance(text);
        const voice = pickAnnouncementVoice(speech.getVoices() ?? []);
        utterance.voice = voice;
        utterance.lang = voice?.lang ?? "en-GB";
        utterance.rate = ANNOUNCEMENT_VOICE_SETTINGS.rate;
        utterance.pitch = ANNOUNCEMENT_VOICE_SETTINGS.pitch;
        utterance.volume = ANNOUNCEMENT_VOICE_SETTINGS.volume;
        utterance.onerror = () => undefined;
        speech.speak(utterance);
        return "SPOKEN";
      } catch {
        return "NONE";
      }
    },
    unlock() {
      if (disposed) return;
      try {
        deps.cues?.unlock();
      } catch {
        // ignore
      }
      try {
        deps.unlockChime?.();
      } catch {
        // ignore
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      silence();
      try {
        deps.cues?.dispose();
      } catch {
        // ignore
      }
    },
  };
}

export type ScanAnnouncer = ReturnType<typeof createScanAnnouncer>;

// ---- Browser wiring ---------------------------------------------------------------------------------------

type AudioContextLike = {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(value: number, at: number): void };
    connect(node: unknown): unknown;
    start(at: number): void;
    stop(at?: number): void;
  };
  createGain(): {
    gain: { setValueAtTime(value: number, at: number): void; exponentialRampToValueAtTime(value: number, at: number): void };
    connect(node: unknown): unknown;
  };
};

let sharedAudioContext: AudioContextLike | null = null;

function audioContext(): AudioContextLike | null {
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : ((window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext ??
        (window as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext);
  if (!Ctor) return null;
  return sharedAudioContext ?? (sharedAudioContext = new Ctor());
}

/** During a user gesture: create / resume the chime's audio context. */
function unlockBrowserChime() {
  const context = audioContext();
  if (context && context.state === "suspended") void context.resume().catch(() => undefined);
}

/** A short, soft two-note chime (E5 then A5, ~0.35 s) through the Web Audio API; no audio file. */
function browserChime(): (() => void) | void {
  const context = audioContext();
  if (!context) return;
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  const start = context.currentTime + 0.01;
  const oscillators = [
    { frequency: 659.25, at: start },
    { frequency: 880, at: start + 0.12 },
  ].map(({ frequency, at }) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.24);
    return oscillator;
  });
  return () => {
    for (const oscillator of oscillators) {
      try {
        oscillator.stop();
      } catch {
        // already stopped
      }
    }
  };
}

/** The announcer for this browser: the two cue files, the chime, and speech when available. */
export function createBrowserScanAnnouncer(): ScanAnnouncer {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? (window.speechSynthesis as unknown as SpeechLike) : null;
  const Utterance =
    typeof window !== "undefined" ? (window as unknown as { SpeechSynthesisUtterance?: new (text: string) => UtteranceLike }).SpeechSynthesisUtterance : undefined;
  // Some browsers load their voice list asynchronously: ask once early so it is ready for the first phrase.
  try {
    synth?.getVoices();
  } catch {
    // ignore
  }
  const AudioCtor = typeof window !== "undefined" ? (window as unknown as { Audio?: new (src: string) => AudioElementLike }).Audio : undefined;
  return createScanAnnouncer({
    speech: synth && Utterance ? synth : null,
    createUtterance: Utterance ? (text) => new Utterance(text) : undefined,
    chime: browserChime,
    cues: createCuePlayer((src) => (AudioCtor ? new AudioCtor(src) : null)),
    unlockChime: unlockBrowserChime,
  });
}
