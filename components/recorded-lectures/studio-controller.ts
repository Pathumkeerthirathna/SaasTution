import { blobByteSource, inspectMp4 } from "@/lib/recorded-lectures/mp4-inspect";

import type { LocalRecording, RecordingStore } from "./recording-store";
import {
  clockElapsed,
  clockPause,
  clockResume,
  clockStart,
  describeMediaError,
  newClock,
  recoverableLength,
  type MediaFailure,
  type RecordingClock,
  type StudioMode,
} from "./studio-helpers";

/*
 * Recording Studio state machine (no React, no globals: every browser API is
 * injected, so permission denials, a cancelled screen share, pause / resume /
 * stop, preview, retake and recovery are unit tested with fakes).
 *
 *   idle -> requesting -> ready (live preview) -> recording <-> paused
 *        -> stopping -> review (the finished file, NOT uploaded) -> saved by the caller
 *
 * Every MediaRecorder timeslice is written to the store at once (IndexedDB in
 * the browser), so a long lesson is not held only in memory and an
 * interrupted recording can be recovered. Nothing is uploaded here: the
 * teacher reviews the recording first and the page then calls the upload.
 */

export const RECORDER_TIMESLICE_MS = 4_000;

export type StudioState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "ready" }
  | { kind: "recording" }
  | { kind: "paused" }
  | { kind: "stopping" }
  | { kind: "review"; recordingId: string; blob: Blob; durationMs: number; check: ReviewCheck; notice: string | null }
  | { kind: "error"; failure: MediaFailure };

/** The server's rules checked on the finished file before it may be saved (same inspector as the server). */
export type ReviewCheck = { ok: true; durationSeconds: number } | { ok: false; message: string };

export type RecorderLike = {
  readonly state: "inactive" | "recording" | "paused";
  start(timeslice: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type TrackLike = { kind: string; stop(): void; onended: (() => void) | null };
export type StreamLike = { getTracks(): TrackLike[]; getVideoTracks(): TrackLike[]; getAudioTracks(): TrackLike[] };

export type StudioDeps = {
  teacherId: string;
  lectureId: string;
  mimeType: string;
  store: RecordingStore;
  getUserMedia(constraints: { video?: unknown; audio?: unknown }): Promise<StreamLike>;
  getDisplayMedia?(constraints: { video?: unknown; audio?: unknown }): Promise<StreamLike>;
  /** A silent AAC-encodable audio track (WebAudio), for camera-only mode. */
  createSilentAudioTrack(): { track: TrackLike; close(): void } | null;
  /** new MediaStream(tracks). */
  combine(tracks: TrackLike[]): StreamLike;
  createRecorder(stream: StreamLike, mimeType: string): RecorderLike;
  now(): number;
  newId(): string;
  maxMoovBytes: number;
  onChange?(state: StudioState): void;
};

export type PrepareOptions = { mode: StudioMode; cameraId?: string | null; microphoneId?: string | null };

export class StudioController {
  private stateValue: StudioState = { kind: "idle" };
  private sources: StreamLike[] = [];
  private silent: { close(): void } | null = null;
  private recordStream: StreamLike | null = null;
  private recorder: RecorderLike | null = null;
  private local: LocalRecording | null = null;
  private chunkIndex = 0;
  private writes: Promise<void> = Promise.resolve();
  private writeFailed = false;
  private clockValue: RecordingClock = newClock();
  private stopped: Promise<void> | null = null;

  constructor(private readonly deps: StudioDeps) {}

  get state(): StudioState {
    return this.stateValue;
  }

  /** What is being recorded (for the live preview element). */
  get liveStream(): StreamLike | null {
    return this.recordStream;
  }

  elapsedMs(now = this.deps.now()): number {
    return clockElapsed(this.clockValue, now);
  }

  private set(state: StudioState) {
    this.stateValue = state;
    this.deps.onChange?.(state);
  }

  private fail(failure: MediaFailure) {
    this.releaseSources();
    this.set({ kind: "error", failure });
  }

  // ---- Devices ---------------------------------------------------------------------------------------

  /** Asks for the devices of `mode` and builds the stream to record (camera / screen + one audio track). */
  async prepare(options: PrepareOptions): Promise<void> {
    if (this.stateValue.kind === "recording" || this.stateValue.kind === "paused" || this.stateValue.kind === "stopping") return;
    this.releaseSources();
    this.set({ kind: "requesting" });
    const audio = options.microphoneId ? { deviceId: { exact: options.microphoneId } } : true;
    const video = options.cameraId ? { deviceId: { exact: options.cameraId } } : true;
    try {
      let tracks: TrackLike[];
      if (options.mode === "screen-mic") {
        if (!this.deps.getDisplayMedia) {
          return this.fail({ code: "NOT_SUPPORTED", message: "Screen recording is not available in this browser.", retryable: false });
        }
        let screen: StreamLike;
        try {
          screen = await this.deps.getDisplayMedia({ video: true, audio: false });
        } catch (error) {
          return this.fail(describeMediaError(error, "screen"));
        }
        this.sources.push(screen);
        let mic: StreamLike;
        try {
          mic = await this.deps.getUserMedia({ audio, video: false });
        } catch (error) {
          return this.fail(describeMediaError(error, "microphone"));
        }
        this.sources.push(mic);
        tracks = [...screen.getVideoTracks(), ...mic.getAudioTracks()];
      } else if (options.mode === "camera-mic") {
        let cam: StreamLike;
        try {
          cam = await this.deps.getUserMedia({ video, audio });
        } catch (error) {
          return this.fail(describeMediaError(error, "camera-and-microphone"));
        }
        this.sources.push(cam);
        tracks = [...cam.getVideoTracks(), ...cam.getAudioTracks()];
      } else {
        let cam: StreamLike;
        try {
          cam = await this.deps.getUserMedia({ video, audio: false });
        } catch (error) {
          return this.fail(describeMediaError(error, "camera"));
        }
        this.sources.push(cam);
        const silent = this.deps.createSilentAudioTrack();
        if (!silent) return this.fail({ code: "NOT_SUPPORTED", message: "This browser cannot add the silent audio track recordings need.", retryable: false });
        this.silent = silent;
        tracks = [...cam.getVideoTracks(), silent.track];
      }
      if (!tracks.some((t) => t.kind === "video") || !tracks.some((t) => t.kind === "audio")) {
        return this.fail({ code: "DEVICE_NOT_FOUND", message: "A video and an audio source are both required.", retryable: true });
      }
      // The screen share or a device can end on its own (browser "Stop sharing", unplugged camera).
      for (const track of tracks) {
        track.onended = () => {
          if (this.stateValue.kind === "recording" || this.stateValue.kind === "paused") void this.stop();
        };
      }
      this.recordStream = this.deps.combine(tracks);
      this.set({ kind: "ready" });
    } catch (error) {
      this.fail(describeMediaError(error, "recorder"));
    }
  }

  // ---- Recording ---------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.stateValue.kind !== "ready" || !this.recordStream) return;
    let recorder: RecorderLike;
    try {
      recorder = this.deps.createRecorder(this.recordStream, this.deps.mimeType);
    } catch (error) {
      return this.fail(describeMediaError(error, "recorder"));
    }
    const now = this.deps.now();
    this.local = {
      id: this.deps.newId(),
      teacherId: this.deps.teacherId,
      lectureId: this.deps.lectureId,
      mimeType: this.deps.mimeType,
      startedAt: now,
      updatedAt: now,
      status: "recording",
      durationMs: 0,
      uploadId: null,
      title: null,
      partNumber: null,
      uploadBytes: null,
    };
    try {
      await this.deps.store.putRecording(this.local);
    } catch {
      return this.fail({ code: "STORAGE_FAILED", message: "The browser could not store the recording. Free some disk space and try again.", retryable: true });
    }
    this.chunkIndex = 0;
    this.writeFailed = false;
    this.writes = Promise.resolve();
    recorder.ondataavailable = (event) => this.onData(event.data);
    recorder.onerror = () => void this.stop(true);
    this.stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    this.recorder = recorder;
    this.clockValue = clockStart(now);
    recorder.start(RECORDER_TIMESLICE_MS);
    this.set({ kind: "recording" });
  }

  private onData(blob: Blob) {
    if (!blob || blob.size === 0 || !this.local) return;
    const recordingId = this.local.id;
    const index = this.chunkIndex++;
    // Written in order, one at a time; a failure stops the recording (never a silent gap).
    this.writes = this.writes.then(async () => {
      if (this.writeFailed) return;
      try {
        await this.deps.store.appendChunk(recordingId, index, blob);
      } catch {
        this.writeFailed = true;
        void this.stop(true);
      }
    });
  }

  pause(): void {
    if (this.stateValue.kind !== "recording" || !this.recorder) return;
    this.recorder.pause();
    this.clockValue = clockPause(this.clockValue, this.deps.now());
    this.set({ kind: "paused" });
  }

  resume(): void {
    if (this.stateValue.kind !== "paused" || !this.recorder) return;
    this.recorder.resume();
    this.clockValue = clockResume(this.clockValue, this.deps.now());
    this.set({ kind: "recording" });
  }

  /** Stops, waits for every chunk to be stored, then shows the finished recording for review. */
  async stop(failed = false): Promise<void> {
    const kind = this.stateValue.kind;
    if ((kind !== "recording" && kind !== "paused") || !this.recorder || !this.local) return;
    this.set({ kind: "stopping" });
    const durationMs = clockElapsed(this.clockValue, this.deps.now());
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // Already stopped by the browser.
    }
    await this.stopped;
    await this.writes;
    this.releaseSources();
    const local = { ...this.local, status: "stopped" as const, durationMs, updatedAt: this.deps.now() };
    this.local = local;
    try {
      await this.deps.store.putRecording(local);
    } catch {
      // The chunks are stored; the status update is best effort.
    }
    const notice = this.writeFailed
      ? "The browser ran out of space, so the recording stopped early. What was saved is shown below."
      : failed
        ? "The recording stopped unexpectedly. What was saved is shown below."
        : null;
    await this.review(local.id, failed || this.writeFailed, notice);
  }

  /** Loads a stored recording (just finished, or recovered after a crash) for review. */
  async review(recordingId: string, interrupted = false, notice: string | null = null): Promise<void> {
    const local = await this.deps.store.getRecording(recordingId);
    if (!local) return this.fail({ code: "NOT_FOUND", message: "The recording is no longer stored in this browser.", retryable: false });
    let blob = await this.deps.store.assemble(recordingId, local.mimeType);
    if (interrupted || local.status === "recording") {
      // Cut an interrupted recording at its last complete fragment.
      const recovered = await recoverableLength(blobByteSource(blob));
      blob = blob.slice(0, recovered.length, local.mimeType);
    }
    const check = await this.checkFile(blob);
    this.local = local;
    this.set({ kind: "review", recordingId, blob, durationMs: local.durationMs, check, notice });
  }

  /** The server's MP4 rules, applied before any byte is uploaded. */
  async checkFile(blob: Blob): Promise<ReviewCheck> {
    if (blob.size === 0) return { ok: false, message: "Nothing was recorded." };
    const result = await inspectMp4(blobByteSource(blob), { maxMoovBytes: this.deps.maxMoovBytes });
    if (!result.ok) return { ok: false, message: "This browser produced a video the server cannot accept (it needs MP4 with H.264 video and AAC audio)." };
    if (result.info.durationSeconds === null || result.info.durationSeconds < 1) {
      return { ok: false, message: "The recording's length could not be read, so it cannot be saved. Please record again." };
    }
    return { ok: true, durationSeconds: result.info.durationSeconds };
  }

  /** Throws the reviewed recording away and returns to the live preview (devices are asked again). */
  async retake(): Promise<void> {
    if (this.stateValue.kind !== "review") return;
    await this.deps.store.deleteRecording(this.stateValue.recordingId);
    this.local = null;
    this.clockValue = newClock();
    this.set({ kind: "idle" });
  }

  /** Stops every camera / microphone / screen track (leaving the page, switching mode). */
  releaseSources(): void {
    for (const stream of this.sources) for (const track of stream.getTracks()) track.stop();
    this.sources = [];
    this.silent?.close();
    this.silent = null;
    this.recordStream = null;
  }
}
