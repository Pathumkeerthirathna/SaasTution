/**
 * The teacher page's YouTube Recording / Live state, around ONE Jibri stream.
 *
 * Jitsi runs one Jibri stream per conference (mode "stream"), feeding the
 * teacher's reusable YouTube stream; Recording and Live (one shared broadcast
 * or two separate ones) both ride on it. Jitsi's status events describe that
 * stream, not a feature, so they are applied to the stream and every feature
 * riding on it — there is no "whichever feature started it last" routing.
 *
 * Feature states:
 *   off       not active
 *   starting  start request sent / waiting for Jibri to confirm the stream
 *   on        active, the stream confirmed by Jibri on this page
 *   restored  active according to the server after a reload; Jibri's state
 *             is not confirmed yet (a Jibri "on" makes it on, "off" ends it)
 *
 * Jibri states: unknown (fresh page / new conference), off, starting, on.
 *
 * A start that this page asked Jibri for stays "starting" until Jibri
 * confirms; a start riding on a stream already confirmed on this page is on
 * at once. A start that fails (timeout, Jibri error) cleans up only what it
 * owns: its own new row (server, `ownsRow`), its own Jibri start, and a
 * confirmation that arrives late is stopped instead of becoming active.
 *
 * Plain TypeScript (no React); JitsiClassroom renders it, tests drive it.
 */

export type YouTubeFeature = "recording" | "live";
export type FeatureState = "off" | "starting" | "on" | "restored";
export type JibriState = "unknown" | "off" | "starting" | "on";

export type YouTubeStartData = {
  success?: boolean;
  error?: string;
  code?: string;
  streamName?: string;
  broadcastId?: string;
  youtubeUrl?: string;
  alreadyStreaming?: boolean;
  startJibri?: boolean;
  rowId?: string;
  /**
   * The row's version as the start left it (an integer; an ISO string from a
   * server before the version counter), sent back unchanged with its cleanup.
   */
  rowVersion?: number | string;
  ownsRow?: boolean;
  ownsBroadcast?: boolean;
  [key: string]: unknown;
};

export type YouTubeStopData = {
  success?: boolean;
  error?: string;
  code?: string;
  stopJibri?: boolean;
  [key: string]: unknown;
};

type ApiResult<T> = { status: number; data: T };

export type YouTubeStreamControllerDeps = {
  startFeature: (feature: YouTubeFeature, options: { privacy?: string }) => Promise<ApiResult<YouTubeStartData>>;
  abortStart: (
    feature: YouTubeFeature,
    body: { rowId: string; ownsBroadcast: boolean; rowVersion?: number | string }
  ) => Promise<ApiResult<YouTubeStopData>>;
  stopFeature: (feature: YouTubeFeature) => Promise<ApiResult<YouTubeStopData>>;
  /** Jitsi startRecording(mode "stream"). */
  startJibri: (streamKey: string, broadcastId: string, feature: YouTubeFeature) => void;
  /** Jitsi stopRecording("stream"). */
  stopJibri: () => void;
  /** How long a start waits for Jibri to confirm (ms). */
  confirmTimeoutMs?: number;
  /** Failed-start cleanup: time limit per attempt (ms). */
  cleanupTimeoutMs?: number;
  /** Failed-start cleanup: waits between attempts (ms); attempts = length + 1. */
  cleanupRetryDelaysMs?: number[];
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (...args: unknown[]) => void;
};

export type YouTubeStreamSnapshot = {
  recording: FeatureState;
  live: FeatureState;
  jibri: JibriState;
};

export type YouTubeStreamChange =
  | { type: "state" }
  /** Jibri stopped / failed while features were active (not asked by this page). */
  | { type: "jibri-stopped"; features: YouTubeFeature[]; error?: string }
  /**
   * A failed start's cleanup could not be confirmed by the server. The
   * feature is shown as restored (its row may still be active), so the
   * normal, server-checked Stop can finish it.
   */
  | { type: "cleanup-pending"; feature: YouTubeFeature }
  /** The class session ended: every feature ended with it. */
  | { type: "session-ended" };

export type StartOutcome =
  | { ok: true; data: YouTubeStartData; reusedStream: boolean }
  | { ok: false; reason: "busy" }
  /** The class session ended before (or while) this start ran: nothing started. */
  | { ok: false; reason: "session-ended" }
  | { ok: false; reason: "api"; status: number; data: YouTubeStartData }
  | {
      ok: false;
      reason: "jibri-timeout" | "jibri-error";
      error?: string;
      data: YouTubeStartData;
      /** The server did not confirm the cleanup (see "cleanup-pending"). */
      cleanupPending?: boolean;
    };

export type StopOutcome =
  | { ok: true; data: YouTubeStopData }
  | { ok: false; status: number; data: YouTubeStopData };

type Waiter = {
  feature: YouTubeFeature;
  settle: (result: { ok: true } | { ok: false; reason: "jibri-timeout" | "jibri-error"; error?: string }) => void;
};

const OTHER: Record<YouTubeFeature, YouTubeFeature> = { recording: "live", live: "recording" };
const isActive = (state: FeatureState) => state !== "off";

export const DEFAULT_CONFIRM_TIMEOUT_MS = 25_000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
export const DEFAULT_CLEANUP_RETRY_DELAYS_MS = [1_000, 3_000];

type CleanupResult =
  | { confirmed: true; stopJibri: boolean }
  | { confirmed: false; status: number };

// Not worth retrying: the request itself is refused (auth, validation, not found).
const isPermanentStatus = (status: number) =>
  status === 400 || status === 401 || status === 403 || status === 404 || status === 422;

export function createYouTubeStreamController(deps: YouTubeStreamControllerDeps) {
  const log = deps.log ?? (() => {});
  const schedule = deps.schedule ?? ((fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  });
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const cleanupRetryDelaysMs = deps.cleanupRetryDelaysMs ?? DEFAULT_CLEANUP_RETRY_DELAYS_MS;

  const state: YouTubeStreamSnapshot = { recording: "off", live: "off", jibri: "unknown" };
  const listeners = new Set<(snapshot: YouTubeStreamSnapshot, change: YouTubeStreamChange) => void>();
  const waiters = new Set<Waiter>();

  // This page asked Jibri to stop: the next "off" event is that stop.
  let expectingStop = false;
  // A failed start had asked Jibri to start: a late "on" must be stopped.
  let lateStopPending = false;
  // Failed starts whose server-side cleanup was not confirmed: shown as
  // restored for the normal Stop, but never adopted by a Jibri "on" and never
  // counted as using the stream.
  const cleanupPending = new Set<YouTubeFeature>();
  // The class session ended: nothing may become active on this page any more.
  let sessionOver = false;

  const snapshot = (): YouTubeStreamSnapshot => ({ ...state });

  function emit(change: YouTubeStreamChange = { type: "state" }) {
    const current = snapshot();
    listeners.forEach(listener => listener(current, change));
  }

  // Features that use (or wait for) the stream; cleanup-pending ones do not.
  function anyFeatureUsingStream() {
    return (["recording", "live"] as const).some(
      feature => isActive(state[feature]) && !cleanupPending.has(feature));
  }

  function sleep(ms: number) {
    return ms > 0 ? new Promise<void>(resolve => { schedule(resolve, ms); }) : Promise.resolve();
  }

  // Rejects after `ms`; a later answer of the original request is ignored.
  function withTimeout<T>(promise: Promise<T>, ms: number) {
    return new Promise<T>((resolve, reject) => {
      const cancel = schedule(() => reject(new Error("Request timed out.")), ms);

      promise.then(
        value => { cancel(); resolve(value); },
        error => { cancel(); reject(error); }
      );
    });
  }

  /**
   * Server-side cleanup of the row a failed start created (`ownsRow`): at most
   * `cleanupRetryDelaysMs.length + 1` attempts, each limited to
   * `cleanupTimeoutMs`. 409, 5xx, network errors and timeouts are retried;
   * auth / validation / not-found are not. Only a successful answer is
   * "confirmed", and only its explicit `stopJibri: true` allows a Jibri stop.
   */
  async function cleanUpOwnRow(feature: YouTubeFeature, data: YouTubeStartData): Promise<CleanupResult> {
    let lastStatus = 0;

    for (let attempt = 0; attempt <= cleanupRetryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await sleep(cleanupRetryDelaysMs[attempt - 1]);
      }

      let response: ApiResult<YouTubeStopData>;

      try {
        response = await withTimeout(
          deps.abortStart(feature, {
            rowId: data.rowId as string,
            ownsBroadcast: data.ownsBroadcast === true,
            // Lets the server see a reuse by another tab since this start.
            ...(typeof data.rowVersion === "number" || typeof data.rowVersion === "string"
              ? { rowVersion: data.rowVersion }
              : {})
          }),
          cleanupTimeoutMs
        );
      } catch (error) {
        lastStatus = 0;
        log("YouTube start cleanup attempt failed:", feature, attempt + 1, error);
        continue;
      }

      const body = response.data ?? {};

      if (response.status >= 200 && response.status < 300 && body.success === true) {
        return { confirmed: true, stopJibri: body.stopJibri === true };
      }

      lastStatus = response.status;
      log("YouTube start cleanup refused:", feature, attempt + 1, response.status, body.code);

      if (isPermanentStatus(response.status) || (response.status >= 200 && response.status < 300)) {
        break;
      }
    }

    return { confirmed: false, status: lastStatus };
  }

  // The server may still see the row as active: show it as restored so the
  // normal, server-checked Stop finishes it. Never a reason to stop Jibri.
  function markCleanupPending(feature: YouTubeFeature) {
    cleanupPending.add(feature);
    state[feature] = "restored";
    emit({ type: "cleanup-pending", feature });
  }

  function requestJibriStop() {
    expectingStop = true;
    state.jibri = "off";
    deps.stopJibri();
  }

  function waitForJibri(feature: YouTubeFeature) {
    return new Promise<{ ok: true } | { ok: false; reason: "jibri-timeout" | "jibri-error"; error?: string }>(resolve => {
      let cancel = () => {};
      const waiter: Waiter = {
        feature,
        settle: result => {
          if (!waiters.has(waiter)) return;
          waiters.delete(waiter);
          cancel();
          resolve(result);
        }
      };

      waiters.add(waiter);
      cancel = schedule(() => waiter.settle({ ok: false, reason: "jibri-timeout" }), confirmTimeoutMs);
    });
  }

  async function start(feature: YouTubeFeature, options: { privacy?: string } = {}): Promise<StartOutcome> {
    if (sessionOver) {
      return { ok: false, reason: "session-ended" };
    }

    if (state[feature] === "starting") {
      return { ok: false, reason: "busy" };
    }

    const previous = state[feature];

    state[feature] = "starting";
    emit();

    let response: ApiResult<YouTubeStartData>;

    try {
      response = await deps.startFeature(feature, options);
    } catch (error) {
      // sessionEnded() during the request already ended every feature.
      state[feature] = sessionOver ? "off" : previous;
      emit();

      return {
        ok: false,
        reason: "api",
        status: 0,
        data: { success: false, error: error instanceof Error ? error.message : "Request failed." }
      };
    }

    const data = response.data ?? {};

    if (sessionOver) {
      // The answer came after the session ended: no Jibri start, and the
      // feature stays off. A row this start created is cleaned up (best
      // effort; an unconfirmed cleanup is left to the server's
      // session-end reconciliation).
      if (data.success && data.ownsRow && data.rowId) {
        await cleanUpOwnRow(feature, data);
      }

      state[feature] = "off";
      emit();

      return { ok: false, reason: "session-ended" };
    }

    if (response.status >= 400 || !data.success || !data.streamName || !data.broadcastId) {
      // Nothing was started on this page. A row the server created without a
      // usable stream key / broadcast ID is cleaned up like a failed start.
      const cleanup = data.success && data.ownsRow && data.rowId
        ? await cleanUpOwnRow(feature, data)
        : null;

      state[feature] = previous;

      if (cleanup && !cleanup.confirmed && !sessionOver) {
        markCleanupPending(feature);
      } else {
        emit();
      }

      return {
        ok: false,
        reason: "api",
        status: response.status,
        data: data.success ? { ...data, success: false, error: data.error ?? "YouTube stream details are missing." } : data
      };
    }

    // Does this start ride on a stream that is already running? Only Jibri's
    // own confirmation on this page proves that. YouTube's `alreadyStreaming`
    // (its stream status, which lags behind Jibri and can stay "active" for a
    // while after a stop) and the database are never taken as proof.
    let startedJibri = false;
    let ridesOnConfirmedStream = false;

    if (state.jibri === "on") {
      ridesOnConfirmedStream = true;
    } else if (state.jibri === "starting") {
      // Wait for the start already in flight.
    } else if (state.jibri === "unknown" && data.startJibri === false) {
      // Unknown here (e.g. after a reload), and the server reports the other
      // feature as active: its stream may be running. Do not start a second
      // one; wait for Jibri to confirm (a timeout cleans up this start).
    } else {
      // Seen stopped on this page, or nothing else is active: start Jibri.
      startedJibri = true;
    }

    if (ridesOnConfirmedStream) {
      state[feature] = "on";
      emit();

      return { ok: true, data, reusedStream: true };
    }

    if (startedJibri) {
      state.jibri = "starting";
      lateStopPending = false;
      emit();
      deps.startJibri(data.streamName, data.broadcastId, feature);
    }

    const confirmation = await waitForJibri(feature);

    if (confirmation.ok) {
      state[feature] = "on";
      emit();

      return { ok: true, data, reusedStream: !startedJibri };
    }

    // Failed: clean up only what this start owns. The feature stays
    // "starting" during the (bounded) cleanup, so no newer start or stop on
    // this page can overlap it.
    log("YouTube start not confirmed by Jibri:", feature, confirmation);

    const cleanup = data.ownsRow && data.rowId ? await cleanUpOwnRow(feature, data) : null;

    if (startedJibri) {
      // A stream this start asked for must never turn into an active one
      // later, unless the server confirmed another feature uses the stream.
      lateStopPending = !(cleanup && cleanup.confirmed && !cleanup.stopJibri);

      if (state.jibri === "starting") {
        state.jibri = "unknown";
      }
    }

    if (cleanup && !cleanup.confirmed && !sessionOver) {
      markCleanupPending(feature);

      return { ok: false, reason: confirmation.reason, error: confirmation.error, data, cleanupPending: true };
    }

    state[feature] = "off";

    // Stop the Jibri start this attempt made only when the server explicitly
    // allowed it and nothing on this page uses the stream. Without such an
    // answer the late-stream safeguard above stays armed instead.
    if (
      startedJibri &&
      cleanup?.confirmed &&
      cleanup.stopJibri &&
      !anyFeatureUsingStream() &&
      state.jibri !== "off"
    ) {
      // The safeguard stays armed: this stop may reach Jitsi while the
      // session is still starting, so a late "on" is stopped again.
      requestJibriStop();
    }

    emit();

    return { ok: false, reason: confirmation.reason, error: confirmation.error, data };
  }

  async function stop(feature: YouTubeFeature): Promise<StopOutcome> {
    let response: ApiResult<YouTubeStopData>;

    try {
      response = await deps.stopFeature(feature);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: { success: false, error: error instanceof Error ? error.message : "Request failed." }
      };
    }

    const data = response.data ?? {};

    if (response.status >= 400 || !data.success) {
      // Nothing changed on the server: the feature stays as it was.
      return { ok: false, status: response.status, data };
    }

    state[feature] = "off";
    cleanupPending.delete(feature);

    // Jibri stops only when the server agrees the other feature is not
    // active AND it is not active / starting on this page either.
    if (data.stopJibri !== false && !isActive(state[OTHER[feature]]) && state.jibri !== "off") {
      requestJibriStop();
    }

    emit();

    return { ok: true, data };
  }

  /** Jitsi recordingStatusChanged for the stream (mode "stream"), already filtered. */
  function onStreamStatus(status: { on: boolean; error?: string }) {
    if (status.on) {
      state.jibri = "on";
      // A stream is running: any stop this page asked for earlier is over
      // (a stop of a stream that never started sends no "off" event).
      expectingStop = false;

      if (sessionOver) {
        // A stream that came up after the session ended: stop it, never adopt it.
        log("Stopping a Jibri stream that came up after the session ended.");
        requestJibriStop();
        emit();
        return;
      }

      const pending = Array.from(waiters);

      pending.forEach(waiter => waiter.settle({ ok: true }));

      (["recording", "live"] as const).forEach(feature => {
        if (state[feature] === "restored" && !cleanupPending.has(feature)) state[feature] = "on";
      });

      if (pending.length === 0 && lateStopPending && !anyFeatureUsingStream()) {
        // A failed start's stream came up late: stop it, never adopt it.
        lateStopPending = false;
        log("Stopping a Jibri stream that came up after its start had failed.");
        requestJibriStop();
      } else if (pending.length > 0) {
        lateStopPending = false;
      }

      emit();
      return;
    }

    // Stream off (or failed).
    state.jibri = "off";

    if (expectingStop) {
      // The stop this page asked for. (A start made since then is unaffected.)
      expectingStop = false;
      emit();
      return;
    }

    Array.from(waiters).forEach(waiter =>
      waiter.settle({ ok: false, reason: "jibri-error", error: status.error }));

    const ended = (["recording", "live"] as const).filter(
      feature => (state[feature] === "on" || state[feature] === "restored") && !cleanupPending.has(feature));

    ended.forEach(feature => { state[feature] = "off"; });

    emit(ended.length ? { type: "jibri-stopped", features: ended, error: status.error } : { type: "state" });
  }

  /**
   * What the server reports (reload restore, live-status SSE). Never overrides
   * a start in progress. Active only marks a feature "restored" (or "on" if
   * this page has already seen Jibri streaming).
   */
  function serverReport(feature: YouTubeFeature, active: boolean) {
    if (state[feature] === "starting") return;
    // After the session ended a report can only be stale: nothing comes back.
    if (sessionOver && active) return;

    // Jibri seen stopped on this page: a database row (e.g. a later SSE
    // snapshot) cannot bring the feature back; nothing is streaming. Once a
    // stream is confirmed again (or the conference changes and Jibri's state
    // is unknown), reports restore as before.
    if (active && state[feature] === "off" && state.jibri !== "off") {
      state[feature] = state.jibri === "on" ? "on" : "restored";
      emit();
    } else if (!active && (state[feature] === "on" || state[feature] === "restored")) {
      state[feature] = "off";
      cleanupPending.delete(feature);
      emit();
    }
  }

  /**
   * The class session ended (here or elsewhere, e.g. from the dashboard): every
   * feature ended with it. Starts still waiting fail, and this page stops the
   * Jibri stream it may still have running for the class.
   */
  function sessionEnded() {
    sessionOver = true;

    Array.from(waiters).forEach(waiter =>
      waiter.settle({ ok: false, reason: "jibri-error", error: "session-ended" }));

    (["recording", "live"] as const).forEach(feature => {
      if (state[feature] !== "starting") state[feature] = "off";
    });
    cleanupPending.clear();
    lateStopPending = false;

    if (state.jibri !== "off") {
      requestJibriStop();
    }

    emit({ type: "session-ended" });
  }

  /** A new Jitsi conference (rejoin / reconnect): Jibri's state is unknown again. */
  function conferenceChanged() {
    if (state.jibri !== "unknown") {
      state.jibri = "unknown";
      emit();
    }
  }

  return {
    getState: snapshot,
    subscribe(listener: (snapshot: YouTubeStreamSnapshot, change: YouTubeStreamChange) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start,
    stop,
    onStreamStatus,
    serverReport,
    conferenceChanged,
    sessionEnded,
    /** Features whose failed-start cleanup is not confirmed yet. */
    pendingCleanups: () => Array.from(cleanupPending)
  };
}

export type YouTubeStreamController = ReturnType<typeof createYouTubeStreamController>;
