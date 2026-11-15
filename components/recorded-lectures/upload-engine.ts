/*
 * Browser upload engine for recorded lectures: drives the EXISTING RL-3
 * protocol (no second backend):
 *
 *   POST /api/lectures/{lectureId}/recorded-lectures/uploads      start
 *   PUT  /api/recorded-lectures/uploads/{uploadId}/chunks         one chunk (Upload-Offset)
 *   POST /api/recorded-lectures/uploads/{uploadId}/complete       202: verification starts
 *   GET  /api/recorded-lectures/uploads/{uploadId}                status (resume point, verification)
 *   DELETE /api/recorded-lectures/uploads/{uploadId}              cancel
 *
 * Bounded memory: the file is never read whole; each request sends one
 * slice of at most the server's chunkBytes (a Blob slice, read by the browser
 * as it sends). Progress is the SERVER-acknowledged byte count
 * (receivedBytes), so it never runs ahead of what is really stored.
 *
 * Resuming always asks the server where it is (status.receivedBytes), so a
 * refresh, a dropped connection or a second tab cannot make the client skip
 * or repeat bytes. Errors the protocol marks as transient (busy, lease held,
 * timeouts, offset drift, network) are retried with backoff; permanent ones
 * stop with a fixed message. "complete" is sent once per verification run
 * (a stalled verification is restarted only when the server reports
 * completionStalled); duplicate-completion answers (409 UPLOAD_COMPLETING /
 * UPLOAD_ALREADY_COMPLETED) simply continue with status polling.
 *
 * Pure orchestration: fetch, timers and the byte source are injected (tests
 * drive the real routes); no DOM, no storage.
 */

export type UploadPhase =
  | "idle"
  | "starting"
  | "uploading"
  | "retrying"
  | "paused"
  | "completing"
  | "verifying"
  | "ready"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled"
  | "error";

export type UploadSnapshot = {
  phase: UploadPhase;
  uploadId: string | null;
  recordingId: string | null;
  receivedBytes: number;
  expectedBytes: number;
  /** A fixed, user-facing explanation for retrying / paused / failed / expired / error. */
  message: string | null;
  /** Error states only: the server code (for tests and decisions), never shown raw. */
  code: string | null;
  /** True when "Sign in" is the fix (session ended). */
  signIn: boolean;
};

export type UploadDeclaration = { title: string; partNumber: number; fileName: string; sizeBytes: number };

/** What is uploaded: anything that can hand out bounded slices (a File, a Blob, or test bytes). */
export type UploadSource = { size: number; slice(start: number, end: number): Blob };

export type UploadDeps = {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Called on every change. */
  onUpdate?: (snapshot: UploadSnapshot) => void;
  /** Network retries before pausing (each with backoff). */
  maxNetworkRetries?: number;
  /** Status poll interval while verifying (ms). */
  pollIntervalMs?: number;
};

type ApiBody = { success?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string; details?: Record<string, unknown> } };

type StatusData = {
  uploadId: string;
  recordingId: string;
  uploadState: "ACTIVE" | "COMPLETING" | "COMPLETED" | "FAILED" | "EXPIRED" | "CANCELLED";
  recordingState: "UPLOADING" | "VERIFYING" | "READY" | "FAILED";
  expectedBytes: number;
  receivedBytes: number;
  chunkBytes: number;
  failureCode: string | null;
  completionStalled: boolean;
};

export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Fixed texts for the codes a teacher can meet (never the server's raw text for unknown codes). */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "Your session has ended. Please sign in again; the upload can then be resumed.",
  TEACHER_ACCOUNT_INACTIVE: "Your account cannot upload recordings right now.",
  LECTURE_NOT_FOUND: "This lecture is no longer available.",
  LECTURE_NOT_ACTIVE: "This lecture is no longer available for uploads.",
  PART_NUMBER_IN_USE: "This lecture already has a recording with that part number. Choose another part number.",
  TOO_MANY_ACTIVE_UPLOADS: "You have too many uploads in progress. Finish or cancel one first.",
  INSUFFICIENT_STORAGE: "There is not enough storage space for this upload right now.",
  // Teacher storage quota (Stage 3.3): the teacher's own allocation, distinct from the server's disk.
  STORAGE_QUOTA_EXCEEDED: "This recording would exceed your storage limit. Delete files you no longer need or ask an administrator for more storage.",
  STORAGE_QUOTA_BUSY: "Storage is busy right now. Please try again in a moment.",
  RECORDED_LECTURES_NOT_CONFIGURED: "Recorded lecture uploads are not available right now.",
  UPLOAD_EXPIRED: "This upload expired before it was finished. Start the upload again.",
  UPLOAD_NOT_FOUND: "This upload no longer exists. Start the upload again.",
  UPLOAD_CANCELLED: "The upload was cancelled.",
  NETWORK: "The connection was lost. The upload is paused; resume it when you are back online.",
  CANCEL_BLOCKED: "The upload could not be cancelled right now. Please try again.",
  VERIFYING_CANNOT_CANCEL: "The video is already being verified and can no longer be cancelled.",
  UNKNOWN: "The upload failed. Please try again.",
};

export function uploadMessage(code: string | null | undefined): string {
  return (code && MESSAGES[code]) || MESSAGES.UNKNOWN;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Stop extends Error {
  constructor(readonly reason: "paused" | "cancelled") {
    super(reason);
  }
}

export class RecordingUploader {
  private snapshot: UploadSnapshot;
  private controller: AbortController | null = null;
  private running = false;
  private completeSent = false;
  private stopRequested: "paused" | "cancelled" | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly lectureId: string,
    private readonly source: UploadSource,
    private readonly declaration: UploadDeclaration,
    private readonly deps: UploadDeps,
    existing?: { uploadId: string; recordingId?: string | null }
  ) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.snapshot = {
      phase: "idle",
      uploadId: existing?.uploadId ?? null,
      recordingId: existing?.recordingId ?? null,
      receivedBytes: 0,
      expectedBytes: source.size,
      message: null,
      code: null,
      signIn: false,
    };
  }

  get state(): UploadSnapshot {
    return { ...this.snapshot };
  }

  private set(patch: Partial<UploadSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.deps.onUpdate?.({ ...this.snapshot });
  }

  private fail(phase: "failed" | "expired" | "error" | "paused", code: string, message?: string) {
    this.set({ phase, code, message: message ?? uploadMessage(code), signIn: code === "UNAUTHORIZED" });
  }

  // ---- HTTP ----------------------------------------------------------------------------------------

  private async call(url: string, init: RequestInit): Promise<{ status: number; body: ApiBody; headers: Headers }> {
    this.controller = new AbortController();
    const response = await this.deps.fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: this.controller.signal });
    let body: ApiBody = {};
    try {
      body = (await response.json()) as ApiBody;
    } catch {
      body = {};
    }
    return { status: response.status, body, headers: response.headers };
  }

  private uploadUrl(): string {
    return `/api/recorded-lectures/uploads/${encodeURIComponent(this.snapshot.uploadId ?? "")}`;
  }

  private async fetchStatus(): Promise<StatusData | null> {
    const res = await this.call(this.uploadUrl(), { method: "GET" });
    if (res.status === 200 && res.body.data) return res.body.data as unknown as StatusData;
    this.handleHardError(res.status, res.body.error?.code);
    return null;
  }

  /** Non-retryable answers: sets the final state. */
  private handleHardError(status: number, code: string | undefined) {
    if (status === 401) return this.fail("error", "UNAUTHORIZED");
    if (code === "UPLOAD_EXPIRED" || status === 410) return this.fail("expired", "UPLOAD_EXPIRED");
    if (code === "UPLOAD_NOT_FOUND") return this.fail("error", "UPLOAD_NOT_FOUND");
    return this.fail("error", code ?? "UNKNOWN");
  }

  // ---- Public controls ---------------------------------------------------------------------------

  /** Starts (or, with an existing uploadId, resumes) and runs until ready / failed / paused / cancelled. */
  async run(): Promise<UploadSnapshot> {
    if (this.running) return this.state;
    this.running = true;
    this.stopRequested = null;
    try {
      if (!this.snapshot.uploadId) {
        const started = await this.start();
        if (!started) return this.state;
      }
      await this.loop();
    } catch (error) {
      if (error instanceof Stop) {
        if (error.reason === "paused") this.set({ phase: "paused", message: null, code: null });
      } else {
        this.fail("error", "UNKNOWN");
      }
    } finally {
      this.running = false;
      this.controller = null;
    }
    return this.state;
  }

  /** Stops sending after aborting the current request; run() resumes from the server's offset. */
  pause() {
    this.stopRequested = "paused";
    this.controller?.abort();
  }

  /** Cancels the upload on the server (the existing cancel; its lease rules apply). */
  async cancel(): Promise<UploadSnapshot> {
    this.stopRequested = "cancelled";
    this.controller?.abort();
    if (!this.snapshot.uploadId) {
      this.set({ phase: "cancelled", message: uploadMessage("UPLOAD_CANCELLED"), code: "UPLOAD_CANCELLED" });
      return this.state;
    }
    this.set({ phase: "cancelling", message: null, code: null });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let res;
      try {
        res = await this.deps.fetch(this.uploadUrl(), { method: "DELETE", credentials: "same-origin", cache: "no-store" });
      } catch {
        await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        continue;
      }
      let body: ApiBody = {};
      try {
        body = (await res.json()) as ApiBody;
      } catch {
        body = {};
      }
      const code = body.error?.code;
      if (res.status === 200) {
        this.set({ phase: "cancelled", message: uploadMessage("UPLOAD_CANCELLED"), code: "UPLOAD_CANCELLED" });
        return this.state;
      }
      if (code === "UPLOAD_COMPLETING" || code === "UPLOAD_ALREADY_COMPLETED") {
        this.fail("error", "VERIFYING_CANNOT_CANCEL");
        return this.state;
      }
      if (res.status === 401) {
        this.fail("error", "UNAUTHORIZED");
        return this.state;
      }
      if (code === "UPLOAD_NOT_FOUND") {
        this.set({ phase: "cancelled", message: uploadMessage("UPLOAD_CANCELLED"), code: "UPLOAD_CANCELLED" });
        return this.state;
      }
      // CHUNK_IN_PROGRESS / UPLOAD_BUSY: a chunk is still being written; wait for its lease.
      const wait = Number(res.headers.get("Retry-After"));
      await this.sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
    this.fail("error", "CANCEL_BLOCKED");
    return this.state;
  }

  // ---- Steps ---------------------------------------------------------------------------------------

  private checkStop() {
    if (this.stopRequested) throw new Stop(this.stopRequested);
  }

  private async start(): Promise<boolean> {
    this.set({ phase: "starting", message: null, code: null, signIn: false });
    let res;
    try {
      res = await this.call(`/api/lectures/${encodeURIComponent(this.lectureId)}/recorded-lectures/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: this.declaration.title,
          partNumber: this.declaration.partNumber,
          fileName: this.declaration.fileName,
          mimeType: "video/mp4",
          sizeBytes: this.declaration.sizeBytes,
        }),
      });
    } catch {
      this.checkStop();
      this.fail("paused", "NETWORK");
      return false;
    }
    if (res.status === 201 && res.body.data) {
      const data = res.body.data as unknown as StatusData;
      this.set({ uploadId: data.uploadId, recordingId: data.recordingId, receivedBytes: data.receivedBytes, expectedBytes: data.expectedBytes });
      return true;
    }
    const code = res.body.error?.code ?? "UNKNOWN";
    if (res.status === 401) this.fail("error", "UNAUTHORIZED");
    else if (code === "UPLOAD_DECLARATION_INVALID") this.fail("error", code, res.body.error?.message ?? uploadMessage("UNKNOWN"));
    else this.fail("error", code);
    return false;
  }

  private async loop(): Promise<void> {
    let networkFailures = 0;
    let status = await this.refresh();
    while (status) {
      this.checkStop();
      if (status.recordingState === "READY") {
        this.set({ phase: "ready", receivedBytes: status.expectedBytes, message: null, code: null });
        return;
      }
      // Expired / cancelled first: the server also marks the recording FAILED for them.
      if (status.uploadState === "EXPIRED" || status.failureCode === "UPLOAD_EXPIRED") return this.fail("expired", "UPLOAD_EXPIRED");
      if (status.uploadState === "CANCELLED" || status.failureCode === "UPLOAD_CANCELLED") {
        this.set({ phase: "cancelled", message: uploadMessage("UPLOAD_CANCELLED"), code: "UPLOAD_CANCELLED" });
        return;
      }
      if (status.uploadState === "FAILED" || status.recordingState === "FAILED") {
        this.fail("failed", status.failureCode ?? "UNKNOWN", failureText(status.failureCode));
        return;
      }
      if (status.uploadState === "COMPLETING" || status.uploadState === "COMPLETED") {
        status = await this.verify(status);
        continue;
      }

      // ACTIVE
      if (status.receivedBytes >= status.expectedBytes) {
        status = await this.complete();
        continue;
      }
      const outcome = await this.sendChunk(status);
      if (outcome.kind === "accepted") {
        networkFailures = 0;
        status = { ...status, receivedBytes: outcome.receivedBytes };
        continue;
      }
      if (outcome.kind === "network") {
        networkFailures += 1;
        if (networkFailures > (this.deps.maxNetworkRetries ?? 5)) {
          this.fail("paused", "NETWORK");
          return;
        }
        this.set({ phase: "retrying", message: uploadMessage("NETWORK"), code: "NETWORK" });
        await this.sleep(BACKOFF_MS[Math.min(networkFailures - 1, BACKOFF_MS.length - 1)]);
        status = await this.refresh();
        continue;
      }
      if (outcome.kind === "retry") {
        this.set({ phase: "retrying", message: null, code: outcome.code });
        await this.sleep(outcome.waitMs);
        status = await this.refresh();
        continue;
      }
      return; // hard error already recorded
    }
  }

  private async refresh(): Promise<StatusData | null> {
    for (let attempt = 0; ; attempt += 1) {
      this.checkStop();
      try {
        const status = await this.fetchStatus();
        if (status) this.set({ uploadId: status.uploadId, recordingId: status.recordingId, receivedBytes: status.receivedBytes, expectedBytes: status.expectedBytes });
        return status;
      } catch {
        this.checkStop();
        if (attempt >= (this.deps.maxNetworkRetries ?? 5)) {
          this.fail("paused", "NETWORK");
          return null;
        }
        this.set({ phase: "retrying", message: uploadMessage("NETWORK"), code: "NETWORK" });
        await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      }
    }
  }

  private async sendChunk(
    status: StatusData
  ): Promise<{ kind: "accepted"; receivedBytes: number } | { kind: "network" } | { kind: "retry"; waitMs: number; code: string } | { kind: "hard" }> {
    const start = status.receivedBytes;
    const end = Math.min(start + status.chunkBytes, status.expectedBytes, this.source.size);
    if (end <= start || this.source.size !== status.expectedBytes) {
      // The local file is not the one the upload was declared for.
      this.fail("error", "SOURCE_MISMATCH", "The selected file does not match this upload. Choose the original file.");
      return { kind: "hard" };
    }
    this.set({ phase: "uploading", message: null, code: null, signIn: false });
    let res;
    try {
      res = await this.call(`${this.uploadUrl()}/chunks`, {
        method: "PUT",
        // Content-Length is set by the browser from the Blob slice (a forbidden header for scripts).
        headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(start) },
        body: this.source.slice(start, end),
      });
    } catch {
      this.checkStop();
      return { kind: "network" };
    }
    if (res.status === 200 && res.body.data) {
      const received = Number(res.body.data.receivedBytes);
      this.set({ receivedBytes: received });
      return { kind: "accepted", receivedBytes: received };
    }
    const code = res.body.error?.code ?? "UNKNOWN";
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1_000;
    // Transient by protocol: re-read the server's offset and continue from there.
    if (
      ["OFFSET_MISMATCH", "CHUNK_IN_PROGRESS", "LEASE_LOST", "UPLOAD_BUSY", "INFLIGHT_CHUNK_CAP", "CHUNK_TIMEOUT", "CHUNK_ABORTED", "CHUNK_INCOMPLETE", "UPLOAD_ALREADY_COMPLETE", "STORAGE_ERROR"].includes(code) ||
      res.status === 503
    ) {
      return { kind: "retry", waitMs: code === "OFFSET_MISMATCH" || code === "UPLOAD_ALREADY_COMPLETE" ? 0 : waitMs, code };
    }
    if (code === "UPLOAD_NOT_ACTIVE" || code === "UPLOAD_COMPLETING") return { kind: "retry", waitMs: 0, code };
    this.handleHardError(res.status, code);
    return { kind: "hard" };
  }

  private async complete(): Promise<StatusData | null> {
    this.set({ phase: "completing", message: null, code: null });
    if (!this.completeSent) {
      this.completeSent = true;
      try {
        const res = await this.call(`${this.uploadUrl()}/complete`, { method: "POST" });
        const code = res.body.error?.code;
        if (res.status !== 202 && code !== "UPLOAD_COMPLETING" && code !== "UPLOAD_ALREADY_COMPLETED") {
          if (code === "UPLOAD_INCOMPLETE") this.completeSent = false; // bytes missing: the loop sends them
          else if (res.status === 401 || code === "UPLOAD_EXPIRED" || code === "UPLOAD_NOT_FOUND") {
            this.handleHardError(res.status, code);
            return null;
          } else if (res.status >= 500) {
            this.completeSent = false;
            await this.sleep(BACKOFF_MS[0]);
          }
        }
      } catch {
        this.checkStop();
        this.completeSent = false; // the request may not have arrived: status decides
        await this.sleep(BACKOFF_MS[0]);
      }
    }
    return this.refresh();
  }

  private async verify(status: StatusData): Promise<StatusData | null> {
    this.set({ phase: "verifying", receivedBytes: status.expectedBytes, message: null, code: null });
    if (status.completionStalled) {
      // The server asks for complete again (its verification stopped, e.g. a restart).
      this.completeSent = false;
      return this.complete();
    }
    await this.sleep(this.deps.pollIntervalMs ?? 3_000);
    return this.refresh();
  }
}

/** Teacher-facing text for a recording failure code (mirrors lib/recorded-lectures/teacher-dto.ts). */
export function failureText(code: string | null): string {
  if (!code) return uploadMessage("UNKNOWN");
  if (code === "DURATION_INVALID") return "The video's duration could not be read, or it is longer than 48 hours.";
  if (code.startsWith("MP4_")) return "The video could not be accepted: it must be an MP4 file with H.264 video and AAC audio.";
  if (code === "UPLOAD_CANCELLED") return uploadMessage("UPLOAD_CANCELLED");
  if (code === "UPLOAD_EXPIRED") return uploadMessage("UPLOAD_EXPIRED");
  return "The uploaded file could not be verified. Please upload it again.";
}

/** "1.5 GB" style for byte counts (display). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Whole-number percentage of the acknowledged bytes (never 100 before the server has every byte). */
export function progressPercent(received: number, expected: number): number {
  if (!(expected > 0)) return 0;
  const pct = Math.floor((received / expected) * 100);
  return Math.max(0, Math.min(received >= expected ? 100 : 99, pct));
}
