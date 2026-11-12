/*
 * Camera access and frame decoding for the teacher's QR scanner (Stage
 * 5.7b-3d), framework-free so it can be tested with fakes (no camera, no
 * DOM). The panel (qr-scanner-panel.tsx) supplies the browser pieces.
 *
 *  - The camera is requested ONLY from start(), which the panel calls from
 *    the teacher's "Start camera" press (iOS Safari also needs that gesture
 *    for playback).
 *  - getUserMedia prefers the rear camera (facingMode "environment", as an
 *    ideal, so laptops with one front camera still work); when the browser
 *    refuses the constraints it retries once with any camera.
 *  - Every track is stopped on stop(), dispose() (unmount / leaving) and when
 *    a start finishes after it was cancelled.
 *  - Errors become a small set of kinds with teacher-facing text.
 *  - Frames are decoded a few times a second, never while the tab is hidden.
 */

export type CameraErrorKind = "UNSUPPORTED" | "INSECURE_CONTEXT" | "PERMISSION_DENIED" | "NO_CAMERA" | "IN_USE" | "FAILED";

export type CameraState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "error"; kind: CameraErrorKind; message: string };

type TrackLike = { stop: () => void };
export type StreamLike = { getTracks: () => TrackLike[] };
export type MediaDevicesLike = { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<StreamLike> };

/** The rear camera when there is one; a moderate resolution is enough for a phone-sized QR. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
};
export const FALLBACK_CAMERA_CONSTRAINTS: MediaStreamConstraints = { audio: false, video: true };

export function cameraSupport(env: { isSecureContext?: boolean; mediaDevices?: MediaDevicesLike | undefined }):
  | { supported: true }
  | { supported: false; kind: "UNSUPPORTED" | "INSECURE_CONTEXT" } {
  if (env.isSecureContext === false) return { supported: false, kind: "INSECURE_CONTEXT" };
  if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") return { supported: false, kind: "UNSUPPORTED" };
  return { supported: true };
}

const errorName = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";

/** getUserMedia / play() failures, by DOMException name (plus older Chrome / Firefox names). */
export function classifyCameraError(error: unknown): CameraErrorKind {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "PERMISSION_DENIED";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "NO_CAMERA";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "IN_USE";
    case "TypeError":
      return "UNSUPPORTED";
    default:
      return "FAILED";
  }
}

const CAMERA_MESSAGES: Record<CameraErrorKind, string> = {
  UNSUPPORTED: "This browser cannot use the camera here. Use the manual entry below, or open this page in an up-to-date Chrome or Safari.",
  INSECURE_CONTEXT: "The camera is only available on a secure (https) connection. Use the manual entry below.",
  PERMISSION_DENIED:
    "Camera access was blocked. Allow the camera for this site in your browser settings (on iPhone: Settings › Safari › Camera), then press Start camera again.",
  NO_CAMERA: "No camera was found on this device. Use the manual entry below, or a handheld scanner.",
  IN_USE: "The camera could not be started. It may be in use by another app or tab: close it, then press Start camera again.",
  FAILED: "The camera could not be started. Press Start camera to try again, or use the manual entry below.",
};

export const cameraErrorMessage = (kind: CameraErrorKind) => CAMERA_MESSAGES[kind];

export function stopMediaStream(stream: StreamLike | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that cannot be stopped is already ended.
    }
  }
}

export type CameraControllerDeps = {
  mediaDevices: MediaDevicesLike | undefined;
  isSecureContext?: boolean;
  /** Shows the stream (video.srcObject, play()); rejects when playback cannot start. */
  attach: (stream: StreamLike) => Promise<void>;
  /** Removes the stream from the video element. */
  detach: () => void;
  /** Starts decoding frames; returns its stop function. */
  startDecoding: () => () => void;
  onChange: (state: CameraState) => void;
};

export function createCameraController(deps: CameraControllerDeps) {
  let state: CameraState = { phase: "idle" };
  let stream: StreamLike | null = null;
  let stopDecoding: (() => void) | null = null;
  let attempt = 0;
  let disposed = false;

  const set = (next: CameraState) => {
    if (disposed) return;
    state = next;
    deps.onChange(next);
  };
  const fail = (kind: CameraErrorKind) => set({ phase: "error", kind, message: cameraErrorMessage(kind) });

  function release() {
    stopDecoding?.();
    stopDecoding = null;
    stopMediaStream(stream);
    stream = null;
    deps.detach();
  }

  async function request(): Promise<StreamLike> {
    const getUserMedia = deps.mediaDevices!.getUserMedia!.bind(deps.mediaDevices);
    try {
      return await getUserMedia(CAMERA_CONSTRAINTS);
    } catch (error) {
      const name = errorName(error);
      if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") return getUserMedia(FALLBACK_CAMERA_CONSTRAINTS);
      throw error;
    }
  }

  return {
    state: () => state,
    /** Only from the teacher's explicit action. */
    async start(): Promise<void> {
      if (disposed || state.phase === "starting" || state.phase === "running") return;
      const support = cameraSupport({ isSecureContext: deps.isSecureContext, mediaDevices: deps.mediaDevices });
      if (!support.supported) return fail(support.kind);

      const mine = ++attempt;
      set({ phase: "starting" });
      let acquired: StreamLike;
      try {
        acquired = await request();
      } catch (error) {
        if (mine === attempt && !disposed) fail(classifyCameraError(error));
        return;
      }
      if (mine !== attempt || disposed) {
        stopMediaStream(acquired); // stopped or left while the permission prompt was open
        return;
      }
      stream = acquired;
      try {
        await deps.attach(acquired);
      } catch (error) {
        if (mine !== attempt || disposed) return;
        release();
        fail(classifyCameraError(error) === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "FAILED");
        return;
      }
      if (mine !== attempt || disposed) return;
      stopDecoding = deps.startDecoding();
      set({ phase: "running" });
    },
    stop() {
      attempt += 1;
      release();
      if (state.phase !== "error") set({ phase: "idle" });
    },
    /** Unmount / leaving: stops every track; nothing afterwards. */
    dispose() {
      attempt += 1;
      release();
      disposed = true;
    },
  };
}

export type CameraController = ReturnType<typeof createCameraController>;

// =========================================================================================
// Frame decoding
// =========================================================================================

export type FrameLike = { data: Uint8ClampedArray; width: number; height: number };

export type FrameScannerDeps = {
  /** The current frame (downscaled), or null when the video has no frame yet. */
  readFrame: () => FrameLike | null;
  /** jsQR in the panel; returns the decoded text or null. */
  decode: (frame: FrameLike) => string | null;
  onDecoded: (text: string) => void;
  isHidden: () => boolean;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  intervalMs?: number;
  hiddenIntervalMs?: number;
};

/** A decode loop: one frame every intervalMs; while the tab is hidden it only waits (no frame read, no decode). */
export function createFrameScanner(deps: FrameScannerDeps) {
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const intervalMs = deps.intervalMs ?? 200;
  const hiddenIntervalMs = deps.hiddenIntervalMs ?? 1_000;
  let handle: unknown = null;
  let active = false;

  function tick() {
    handle = null;
    if (!active) return;
    if (deps.isHidden()) {
      handle = schedule(tick, hiddenIntervalMs);
      return;
    }
    try {
      const frame = deps.readFrame();
      const text = frame ? deps.decode(frame) : null;
      if (text) deps.onDecoded(text);
    } catch {
      // A frame that cannot be read or decoded is skipped.
    }
    if (active) handle = schedule(tick, intervalMs);
  }

  return {
    start() {
      if (active) return;
      active = true;
      handle = schedule(tick, 0);
    },
    stop() {
      active = false;
      if (handle !== null) cancel(handle);
      handle = null;
    },
    running: () => active,
  };
}

/** The frame size to decode: the longest side at most `max` pixels (decoding cost grows with the area). */
export function decodeSize(width: number, height: number, max = 720): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
