/*
 * QR attendance scanner: spoken confirmation of a NEW attendance mark.
 *
 * Browser-only, no dependencies, no network: the Web Speech API
 * (speechSynthesis) says "Attendance marked for <name>.", preferring a
 * female-sounding English voice when one is installed; where speech is not
 * available (or fails) a short two-note chime is played with the Web Audio
 * API instead. Everything is fire-and-forget: it never throws, never awaits
 * anything the scanner waits for, and never touches the camera or the queue.
 *
 * WHEN to announce is decided by shouldAnnounceScan (pure): only a server
 * answer that is a VALID scan whose effect is STATUS_UPDATED, with a
 * PRESENT / LATE status and the student's name AS RETURNED BY THE SERVER
 * (never anything read from the QR payload), and only the first time for that
 * student while this scanner is open. Duplicates ("Already recorded"),
 * evidence-only scans, reviews, refusals and errors are never announced.
 *
 * Overlap: a new announcement cancels the one still speaking (and stops a
 * chime still sounding), so rapid scans never queue up a backlog of speech.
 */

import type { QrScanResponse } from "@/components/attendance/qr-scanner-logic";

const MARKED_STATUSES = new Set(["PRESENT", "LATE"]);
const MAX_SPOKEN_NAME_LENGTH = 80;

/** Pure: should this answer be announced? `announced` holds the student ids already announced. */
export function shouldAnnounceScan(outcome: QrScanResponse, announced: ReadonlySet<string>): boolean {
  if (outcome.result !== "VALID" || outcome.effect !== "STATUS_UPDATED") return false;
  if (!outcome.student || !outcome.attendance || !MARKED_STATUSES.has(outcome.attendance.status)) return false;
  if (spokenName(outcome.student.name) === "") return false;
  return !announced.has(outcome.student.studentId);
}

/** The name as it is spoken: control characters removed, whitespace collapsed, bounded. */
export function spokenName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPOKEN_NAME_LENGTH);
}

export function announcementText(name: string): string {
  return `Attendance marked for ${spokenName(name)}.`;
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
  /** null / undefined: no speech synthesis here (the chime is used). */
  speech?: SpeechLike | null;
  createUtterance?: (text: string) => UtteranceLike;
  /** Plays the success chime; returns a stop function. */
  chime?: () => (() => void) | void;
};

export const ANNOUNCEMENT_VOICE_SETTINGS = { rate: 0.95, pitch: 1, volume: 0.9 } as const;

/**
 * One announcer per scanner page. `announce(name)` cancels anything still
 * playing and starts the new announcement; `dispose()` silences it.
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
  };

  const playChime = () => {
    if (!deps.chime) return;
    try {
      stopChime = deps.chime() ?? null;
    } catch {
      stopChime = null;
    }
  };

  return {
    announce(name: string): "SPOKEN" | "CHIME" | "NONE" {
      if (disposed) return "NONE";
      silence();
      const speech = deps.speech;
      if (speech && deps.createUtterance) {
        try {
          const utterance = deps.createUtterance(announcementText(name));
          const voice = pickAnnouncementVoice(speech.getVoices() ?? []);
          utterance.voice = voice;
          utterance.lang = voice?.lang ?? "en-GB";
          utterance.rate = ANNOUNCEMENT_VOICE_SETTINGS.rate;
          utterance.pitch = ANNOUNCEMENT_VOICE_SETTINGS.pitch;
          utterance.volume = ANNOUNCEMENT_VOICE_SETTINGS.volume;
          // "interrupted" / "canceled" are our own cancel(): no chime then.
          utterance.onerror = (event) => {
            if (!disposed && event?.error !== "interrupted" && event?.error !== "canceled") playChime();
          };
          speech.speak(utterance);
          return "SPOKEN";
        } catch {
          // fall through to the chime
        }
      }
      playChime();
      return deps.chime ? "CHIME" : "NONE";
    },
    dispose() {
      disposed = true;
      silence();
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

/** A short, soft two-note chime (E5 then A5, ~0.35 s) through the Web Audio API; no audio file. */
function browserChime(): (() => void) | void {
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : ((window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext ??
        (window as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext);
  if (!Ctor) return;
  const context = sharedAudioContext ?? (sharedAudioContext = new Ctor());
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

/** The announcer for this browser (speech when available, the chime otherwise). */
export function createBrowserScanAnnouncer(): ScanAnnouncer {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? (window.speechSynthesis as unknown as SpeechLike) : null;
  const Utterance =
    typeof window !== "undefined" ? (window as unknown as { SpeechSynthesisUtterance?: new (text: string) => UtteranceLike }).SpeechSynthesisUtterance : undefined;
  // Some browsers load their voice list asynchronously: ask once early so it is ready for the first scan.
  try {
    synth?.getVoices();
  } catch {
    // ignore
  }
  return createScanAnnouncer({
    speech: synth && Utterance ? synth : null,
    createUtterance: Utterance ? (text) => new Utterance(text) : undefined,
    chime: browserChime,
  });
}
