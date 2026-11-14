/*
 * Recording Studio helpers (pure: no DOM objects created here, everything
 * the browser provides is passed in, so the logic is unit tested).
 *
 * FORMAT. The server accepts ONLY MP4 with H.264 video and AAC audio (RL-1
 * mp4-inspect). The studio therefore records with MediaRecorder only when the
 * browser can produce exactly that (isTypeSupported on an explicit
 * "video/mp4;codecs=avc1…,mp4a.40.2" type); there is no server-side
 * transcoding. Browsers that cannot (e.g. Firefox, which records WebM only)
 * are told so and can still upload an MP4 made with another app.
 *
 * Every recording has an AAC audio track (the server requires one): camera
 * only mode records a silent track made by the page (WebAudio), not silence
 * by omission.
 */

/** Tried in order; the first the browser supports is used. All are H.264 + AAC-LC in MP4. */
export const RECORDER_MIME_CANDIDATES: readonly string[] = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=\"avc1.42E01F, mp4a.40.2\"",
];

/** The recorder type to use, or null when the browser cannot record H.264 + AAC MP4. */
export function pickRecorderMimeType(isTypeSupported: ((type: string) => boolean) | undefined | null): string | null {
  if (typeof isTypeSupported !== "function") return null;
  for (const type of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // A browser that throws for a type does not support it.
    }
  }
  return null;
}

export type StudioMode = "camera-mic" | "screen-mic" | "camera-only";

export const STUDIO_MODES: readonly { mode: StudioMode; label: string; help: string }[] = [
  { mode: "camera-mic", label: "Camera + microphone", help: "Records you through your camera with your voice." },
  { mode: "screen-mic", label: "Screen + microphone", help: "Records your screen, a window or a tab with your voice." },
  { mode: "camera-only", label: "Camera only (no sound)", help: "Records your camera with a silent audio track." },
];

export type StudioEnvironment = {
  isSecureContext?: boolean;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
  hasMediaRecorder: boolean;
  isTypeSupported?: ((type: string) => boolean) | null;
  hasAudioContext: boolean;
};

export type StudioSupport = {
  /** The studio can record at all (MP4 H.264 + AAC recorder). */
  supported: boolean;
  mimeType: string | null;
  modes: Record<StudioMode, boolean>;
  /** Why something is unavailable (fixed texts). */
  reasons: string[];
};

export const SUPPORTED_BROWSERS_TEXT =
  "Recording works in desktop Chrome and Edge (recent versions) and Safari. Screen recording needs a desktop browser. " +
  "Firefox cannot record MP4 video: use another browser, or record with another app and upload the MP4 file.";

export function studioSupport(env: StudioEnvironment): StudioSupport {
  const reasons: string[] = [];
  if (env.isSecureContext === false) reasons.push("Recording needs a secure (https) connection.");
  if (!env.hasMediaRecorder) reasons.push("This browser cannot record video.");
  const mimeType = env.hasMediaRecorder ? pickRecorderMimeType(env.isTypeSupported) : null;
  if (env.hasMediaRecorder && !mimeType) reasons.push("This browser cannot record MP4 (H.264 + AAC) video, which recorded lectures require.");
  if (!env.hasGetUserMedia) reasons.push("This browser cannot use a camera or microphone here.");
  if (!env.hasGetDisplayMedia) reasons.push("Screen recording is not available in this browser (it needs a desktop browser).");
  const recordable = env.isSecureContext !== false && Boolean(mimeType);
  const modes: Record<StudioMode, boolean> = {
    "camera-mic": recordable && env.hasGetUserMedia,
    "screen-mic": recordable && env.hasGetUserMedia && env.hasGetDisplayMedia,
    "camera-only": recordable && env.hasGetUserMedia && env.hasAudioContext,
  };
  return { supported: recordable && Object.values(modes).some(Boolean), mimeType, modes, reasons };
}

export type MediaFailure = { code: string; message: string; retryable: boolean };

/** A getUserMedia / getDisplayMedia / MediaRecorder failure as a fixed message. */
export function describeMediaError(error: unknown, source: "camera" | "microphone" | "camera-and-microphone" | "screen" | "recorder"): MediaFailure {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  const device = source === "camera" ? "camera" : source === "microphone" ? "microphone" : source === "screen" ? "screen" : "camera and microphone";
  if (source === "screen" && (name === "NotAllowedError" || name === "AbortError")) {
    return { code: "SCREEN_SHARE_CANCELLED", message: "Screen sharing was cancelled. Choose a screen, window or tab to record.", retryable: true };
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return {
      code: "PERMISSION_DENIED",
      message: `Permission to use the ${device} was denied. Allow it in your browser's site settings, then try again.`,
      retryable: true,
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { code: "DEVICE_NOT_FOUND", message: `No ${device} was found. Connect one or choose another device.`, retryable: true };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return { code: "DEVICE_BUSY", message: `The ${device} is being used by another app. Close it and try again.`, retryable: true };
  }
  if (name === "NotSupportedError" || name === "TypeError") {
    return { code: "NOT_SUPPORTED", message: "This browser cannot record in the required format.", retryable: false };
  }
  return { code: "MEDIA_ERROR", message: `The ${device} could not be started. Please try again.`, retryable: true };
}

// ---- Recording clock (pause aware) ---------------------------------------------------------------------

export type RecordingClock = { startedAt: number | null; pausedAt: number | null; pausedTotal: number };

export const newClock = (): RecordingClock => ({ startedAt: null, pausedAt: null, pausedTotal: 0 });
export const clockStart = (now: number): RecordingClock => ({ startedAt: now, pausedAt: null, pausedTotal: 0 });
export function clockPause(clock: RecordingClock, now: number): RecordingClock {
  return clock.startedAt === null || clock.pausedAt !== null ? clock : { ...clock, pausedAt: now };
}
export function clockResume(clock: RecordingClock, now: number): RecordingClock {
  return clock.pausedAt === null ? clock : { ...clock, pausedAt: null, pausedTotal: clock.pausedTotal + Math.max(0, now - clock.pausedAt) };
}
/** Recorded milliseconds (paused time excluded). */
export function clockElapsed(clock: RecordingClock, now: number): number {
  if (clock.startedAt === null) return 0;
  const end = clock.pausedAt ?? now;
  return Math.max(0, end - clock.startedAt - clock.pausedTotal);
}
/** 3725000 ms -> "1:02:05"; 65000 -> "01:05". */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---- Recovery: cut an interrupted recording at its last complete fragment ---------------------------------

export type ByteReader = { size: number; read(offset: number, length: number): Promise<Uint8Array> };

export type RecoveredLength = {
  /** Bytes to keep (0: nothing usable). */
  length: number;
  /** A moov was found among the complete boxes. */
  hasMoov: boolean;
  /** Complete media fragments kept. */
  fragments: number;
  /** Bytes dropped from the end (an incomplete box or an unfinished fragment). */
  droppedBytes: number;
};

function u32(b: Uint8Array, at: number): number {
  return b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}

/**
 * A recording interrupted by a crash ends in the middle of a box. Walk the
 * top-level box headers and keep everything up to the end of the last
 * COMPLETE media fragment (a moof followed by its complete mdat), or up to
 * the moov when no fragment is complete. Header reads only (bounded).
 * The result must still pass the normal MP4 inspection before upload.
 */
export async function recoverableLength(source: ByteReader, maxBoxes = 300_000): Promise<RecoveredLength> {
  let offset = 0;
  let boxes = 0;
  let hasMoov = false;
  let keep = 0;
  let fragments = 0;
  let pendingMoof = false;
  while (offset + 8 <= source.size && boxes < maxBoxes) {
    boxes += 1;
    const header = await source.read(offset, Math.min(16, source.size - offset));
    if (header.length < 8) break;
    const size32 = u32(header, 0);
    const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
    let size = size32;
    if (size32 === 1) {
      if (header.length < 16) break;
      const high = u32(header, 8);
      if (high >= 0x200000) break;
      size = high * 4294967296 + u32(header, 12);
    }
    if (size32 === 0 || size < 8 || offset + size > source.size) break; // incomplete (or "to end of file": unknown)
    const end = offset + size;
    if (type === "ftyp") keep = Math.max(keep, end);
    else if (type === "moov") {
      hasMoov = true;
      keep = end;
    } else if (type === "moof") pendingMoof = true;
    else if (type === "mdat" && pendingMoof) {
      pendingMoof = false;
      fragments += 1;
      keep = end;
    } else if (!pendingMoof) keep = end; // other complete boxes between fragments (styp, sidx, free)
    offset = end;
  }
  if (!hasMoov) return { length: 0, hasMoov: false, fragments: 0, droppedBytes: source.size };
  return { length: keep, hasMoov, fragments, droppedBytes: source.size - keep };
}

/** A suggested title for a new part (the teacher can change it). */
export function suggestedRecordingTitle(lectureTitle: string, partNumber: number): string {
  const base = lectureTitle.trim() || "Lecture recording";
  const title = partNumber > 1 ? `${base} (part ${partNumber})` : base;
  return Array.from(title).slice(0, 200).join("");
}

/** A file name for an MP4 recorded in the studio. */
export function studioFileName(lectureTitle: string, startedAtMs: number): string {
  const date = new Date(startedAtMs).toISOString().slice(0, 10);
  const safe = lectureTitle.replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 80) || "recording";
  return `${safe} ${date}.mp4`;
}
