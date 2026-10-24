// Video diagnostics (Phase 1): the teacher page's side of custom.js's video
// quality telemetry. Message building, validation of what custom.js reports,
// and the summary lines the teacher sees. Plain JavaScript with JSDoc types
// so the same code runs in the app (useJitsi, JitsiClassroom, SidebarNav) and
// in the Node test runner (tests/jitsi). Read-only: nothing here changes any
// video setting.

/** Snapshots kept for "Copy diagnostics" (5 s apart: about 10 minutes). */
export const VIDEO_TELEMETRY_HISTORY_LIMIT = 120;

/** Most student rows accepted from one status (custom.js sends at most 200). */
export const VIDEO_TELEMETRY_MAX_STUDENTS = 200;

export const NOT_AVAILABLE = "N/A";

/**
 * @param {number} epoch
 * @param {boolean} enabled
 * @returns {{ type: "SL_VIDEO_TELEMETRY", v: 1, epoch: number, enabled: boolean }}
 */
export function buildVideoTelemetryMessage(epoch, enabled) {
  return { type: "SL_VIDEO_TELEMETRY", v: 1, epoch, enabled: Boolean(enabled) };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * custom.js's SL_VIDEO_TELEMETRY_STATUS, or null when it is not one. Only
 * the shape is checked here (custom.js already sanitises every student
 * report); values that are not numbers are shown as N/A.
 *
 * @param {unknown} data
 */
export function parseVideoTelemetryStatus(data) {
  if (!isObject(data) || data.type !== "SL_VIDEO_TELEMETRY_STATUS" || data.v !== 1
    || typeof data.enabled !== "boolean" || typeof data.active !== "boolean"
    || (data.send !== null && !isObject(data.send))
    || !Array.isArray(data.students)) {
    return null;
  }

  return {
    enabled: data.enabled,
    active: data.active,
    intervalMs: isNumber(data.intervalMs) ? data.intervalMs : null,
    error: typeof data.error === "string" ? data.error : null,
    send: data.send,
    students: data.students
      .filter((row) => isObject(row) && typeof row.participantId === "string")
      .slice(0, VIDEO_TELEMETRY_MAX_STUDENTS),
    // Students in the meeting who sent no report (custom.js 1014+).
    silent: Array.isArray(data.silent)
      ? data.silent.filter((id) => typeof id === "string").slice(0, VIDEO_TELEMETRY_MAX_STUDENTS)
      : [],
    messaging: isObject(data.messaging) ? data.messaging : null,
  };
}

/**
 * @param {unknown} value
 * @param {number} [digits]
 */
function formatNumber(value, digits = 0) {
  if (!isNumber(value)) {
    return NOT_AVAILABLE;
  }

  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** "720p" from a frame height. @param {unknown} height */
export function formatHeight(height) {
  return isNumber(height) && height > 0 ? `${Math.round(height)}p` : NOT_AVAILABLE;
}

/** "1280×720". @param {unknown} width @param {unknown} height */
export function formatSize(width, height) {
  return isNumber(width) && isNumber(height) && width > 0 && height > 0
    ? `${Math.round(width)}×${Math.round(height)}`
    : NOT_AVAILABLE;
}

/** "21 FPS". @param {unknown} fps */
export function formatFps(fps) {
  return isNumber(fps) ? `${formatNumber(fps, 1)} FPS` : `${NOT_AVAILABLE} FPS`;
}

/** "1,000 kbps". @param {unknown} kbps */
export function formatKbps(kbps) {
  return isNumber(kbps) ? `${formatNumber(kbps)} kbps` : `${NOT_AVAILABLE} kbps`;
}

/** "112.3 MB" (decimal units, like data plans). @param {unknown} bytes */
export function formatBytes(bytes) {
  if (!isNumber(bytes) || bytes < 0) {
    return NOT_AVAILABLE;
  }

  if (bytes >= 1e9) {
    return `${formatNumber(bytes / 1e9, 2)} GB`;
  }

  return `${formatNumber(bytes / 1e6, 1)} MB`;
}

/** @param {unknown} value */
function formatPercent(value) {
  return isNumber(value) ? `${formatNumber(value, 1)}%` : NOT_AVAILABLE;
}

/** @param {unknown} value */
function formatText(value) {
  return typeof value === "string" && value ? value : NOT_AVAILABLE;
}

/**
 * The teacher's outgoing camera, one line. The FPS is ENCODED frames per
 * second (a getStats delta), never the camera's configured rate.
 *
 * @param {any} send
 */
export function formatSendSummary(send) {
  if (!isObject(send)) {
    return `Teacher sending: ${NOT_AVAILABLE}`;
  }

  if (send.camera === false) {
    return "Teacher sending: camera off";
  }

  const encoded = isObject(send.encoded) ? send.encoded : {};

  return [
    `Teacher sending (encoded): ${formatHeight(encoded.height)}`,
    formatFps(encoded.fps),
    formatKbps(send.kbps),
    `limitation: ${formatText(send.limitation)}`,
  ].join(" · ");
}

/**
 * What the camera delivered (measured) next to what it was configured for.
 *
 * @param {any} send
 */
export function formatCaptureLine(send) {
  if (!isObject(send) || send.camera === false) {
    return null;
  }

  const capture = isObject(send.capture) ? send.capture : {};
  const configured = isObject(send.configured) ? send.configured : {};

  return `Camera capture (measured): ${formatSize(capture.width, capture.height)} · ${formatFps(capture.fps)}`
    + ` — configured ${formatSize(configured.width, configured.height)} @ ${formatFps(configured.frameRate)}`;
}

/**
 * The camera track before WebRTC (MediaStreamTrack.stats): frames the camera
 * produced versus those the track delivered or discarded, the camera's own
 * maximum and the frame-rate constraint in force.
 *
 * @param {any} send
 */
export function formatTrackLine(send) {
  if (!isObject(send) || send.camera === false || !isObject(send.track)) {
    return null;
  }

  const track = send.track;
  const configured = isObject(send.configured) ? send.configured : {};

  return [
    track.statsSupported
      ? `Camera track: produced ${formatFps(track.producedFps)}, delivered ${formatFps(track.deliveredFps)}, discarded ${formatFps(track.discardedFps)}`
      : `Camera track: frame counters ${NOT_AVAILABLE} in this browser`,
    `camera max ${formatFps(track.capabilityMaxFps)}`,
    `frame-rate constraint ${formatText(track.frameRateConstraint)}`,
    `resize ${formatText(configured.resizeMode)}`,
    `device ${formatText(track.label)}`,
  ].join(" · ");
}

/** "bandwidth 40%, cpu 0%" (time share of the last interval). @param {any} shares */
function formatShares(shares) {
  if (!isObject(shares)) {
    return NOT_AVAILABLE;
  }

  return ["bandwidth", "cpu", "other"]
    .map((reason) => `${reason} ${formatPercent(shares[reason])}`)
    .join(", ");
}

/**
 * Encoder and network details of the teacher's outgoing camera.
 *
 * @param {any} send
 */
export function formatSendDetails(send) {
  if (!isObject(send) || send.camera === false) {
    return null;
  }

  const encoded = isObject(send.encoded) ? send.encoded : {};
  const network = isObject(send.network) ? send.network : {};
  const svc = isNumber(encoded.layerFrameRate) && encoded.fpsSource === "browser";
  const encodeMs = isNumber(encoded.encodeMsPerFrame)
    ? `${formatNumber(encoded.encodeMsPerFrame, 1)} ms/${svc ? "layer frame" : "frame"}`
    : NOT_AVAILABLE;
  const rtt = isNumber(network.rttMs) ? `${formatNumber(network.rttMs)} ms` : NOT_AVAILABLE;
  const activeLayers = isNumber(encoded.activeSpatialLayers) ? ` (${encoded.activeSpatialLayers} spatial active)` : "";

  return [
    `codec ${formatText(send.codec)}`,
    `encoder ${formatText(send.encoder)}`,
    `layers ${formatText(send.scalabilityMode)}${activeLayers}`,
    // Spatial SVC: the FPS above is the browser's picture rate; this is the
    // per-layer count it is checked against.
    ...(svc ? [`layer frames ${formatNumber(encoded.layerFrameRate, 1)}/s`] : []),
    `encode ${encodeMs}`,
    `encoder target ${formatKbps(send.targetKbpsTotal)}`,
    `available ${formatKbps(network.availableOutgoingKbps)}`,
    `loss ${formatPercent(send.lossPct)}`,
    `RTT ${rtt}`,
    `limited (last interval): ${formatShares(send.limitationShares)}`,
  ].join(" · ");
}

/**
 * The source a student row is about: the teacher's camera when the student
 * receives it, else the first source reported.
 *
 * @param {any} row
 */
export function primaryReceivedSource(row) {
  const sources = isObject(row) && Array.isArray(row.sources) ? row.sources.filter(isObject) : [];

  return sources.find((source) => source.role === "moderator" && source.videoType === "camera")
    || sources[0]
    || null;
}

/**
 * One student's line. The FPS is DECODED frames per second (a getStats
 * delta in the student's browser).
 *
 * @param {string} label
 * @param {any} row
 */
export function formatReceiveSummary(label, row) {
  const source = primaryReceivedSource(row);
  const stale = isObject(row) && row.stale === true
    ? ` (no report for ${formatNumber(row.ageSeconds)} s)`
    : "";

  if (!source) {
    return `${label} receiving: no video${stale}`;
  }

  const what = source.role === "moderator"
    ? source.videoType === "desktop" ? "teacher screen" : "teacher camera"
    : source.videoType === "desktop" ? "a screen share" : "a camera";

  return [
    `${label} receiving ${what} (decoded): ${formatHeight(source.height)}`,
    formatFps(source.fps),
    formatKbps(source.kbps),
    `loss ${formatPercent(source.lossPct)}`,
  ].join(" · ") + stale;
}

/**
 * Details for one student: what their browser asked the bridge for, and
 * what it costs them.
 *
 * @param {any} row
 */
export function formatReceiveDetails(row) {
  const source = primaryReceivedSource(row);
  const network = isObject(row) && isObject(row.network) ? row.network : {};
  const rtt = isNumber(network.rttMs) ? `${formatNumber(network.rttMs)} ms` : NOT_AVAILABLE;

  if (!source) {
    return null;
  }

  return [
    `custom.js ${isNumber(row.customJsVersion) ? row.customJsVersion : NOT_AVAILABLE}`,
    `asked ${formatHeight(source.requestedHeight)}`,
    `forwarding ${formatText(source.streamingStatus)}`,
    `codec ${formatText(source.codec)}`,
    `dropped ${formatNumber(source.framesDropped)} · freezes ${formatNumber(source.freezeCount)}`,
    `received ${formatBytes(network.bytesReceived)} · sent ${formatBytes(network.bytesSent)} in total`,
    `upload ${formatKbps(network.sendKbps)}`,
    `RTT ${rtt}`,
  ].join(" · ");
}

/**
 * How the request / report exchange is going, one line: students in the
 * meeting, how many report, and what the teacher's side counted.
 *
 * @param {any} status
 */
export function formatMessagingLine(status) {
  const messaging = isObject(status) && isObject(status.messaging) ? status.messaging : null;

  if (!messaging) {
    return null;
  }

  const reporting = Array.isArray(status.students) ? status.students.length : 0;
  const errors = isNumber(messaging.requestErrors) && messaging.requestErrors > 0
    ? ` (${formatNumber(messaging.requestErrors)} failed${messaging.lastSendError ? `: ${messaging.lastSendError}` : ""})`
    : "";

  return [
    `Students in meeting ${formatNumber(messaging.studentsPresent)}, reporting ${formatNumber(reporting)}`,
    `requests sent ${formatNumber(messaging.requestsSent)}${errors}`,
    `reports accepted ${formatNumber(messaging.reportsAccepted)}`,
    `ignored (not in meeting ${formatNumber(messaging.reportsIgnoredNotInMeeting)}, from a moderator ${formatNumber(messaging.reportsIgnoredFromModerator)})`,
  ].join(" · ");
}

/**
 * The name to show for a reporting participant: the class student whose
 * authenticated registration maps to this Jitsi participant ID (the same
 * participant map the rest of the classroom uses). Anyone not registered is
 * not given a student's name.
 *
 * @param {string} participantId
 * @param {Record<string, string>} participantMap studentId -> participantId
 * @param {Array<{ studentId: string, displayName: string }>} students
 * @returns {{ label: string, studentId: string | null }}
 */
export function resolveStudentLabel(participantId, participantMap, students) {
  const entry = Object.entries(participantMap || {}).find(([, id]) => id === participantId);
  const studentId = entry ? entry[0] : null;
  const student = studentId ? (students || []).find((item) => item.studentId === studentId) : null;

  if (student && student.displayName) {
    return { label: student.displayName, studentId };
  }

  return { label: `Unregistered participant ${participantId}`, studentId };
}

/**
 * A bounded list of snapshots (oldest dropped first).
 *
 * @param {number} [limit]
 */
export function createTelemetryHistory(limit = VIDEO_TELEMETRY_HISTORY_LIMIT) {
  /** @type {Array<{ at: string, status: any }>} */
  let entries = [];

  return {
    /** @param {any} status @param {Date} [now] */
    push(status, now = new Date()) {
      entries.push({ at: now.toISOString(), status });

      if (entries.length > limit) {
        entries = entries.slice(entries.length - limit);
      }
    },
    entries: () => entries.slice(),
    clear() {
      entries = [];
    },
    get size() {
      return entries.length;
    },
  };
}

/**
 * The JSON the teacher copies as evidence: every kept snapshot, with each
 * student row labelled as shown on screen.
 *
 * @param {Array<{ at: string, status: any }>} entries
 * @param {(participantId: string) => string} labelOf
 * @param {Record<string, unknown>} [context]
 */
export function buildDiagnosticsExport(entries, labelOf, context = {}) {
  return JSON.stringify({
    kind: "sl-classroom-video-diagnostics",
    v: 1,
    exportedAt: new Date().toISOString(),
    ...context,
    samples: entries.map((entry) => ({
      at: entry.at,
      ...entry.status,
      students: (entry.status?.students || []).map((/** @type {any} */ row) => ({
        label: labelOf(row.participantId),
        ...row,
      })),
    })),
  }, null, 2);
}
