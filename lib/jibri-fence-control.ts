import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { serverNow } from "@/lib/server-clock";
import {
  JIBRI_SECRET_IDENTITY_FIELDS,
  JIBRI_WORKER_VERSION,
  diffJibriWorkerIdentity,
  expectedJibriWorkerIdentity,
  type JibriIdentityField,
  type JibriWorkerIdentity,
} from "@/lib/jibri-stop-config";

/*
 * The ONE durable source of the Jibri shutdown fence's mode, and the
 * worker's health (table JibriShutdownControl, row "default"). The Next.js
 * app and the worker (scripts/jibri-stop-worker.ts) both read the mode from
 * here, so they cannot disagree about it; no environment flag decides it.
 * (The worker still needs its own explicit environment to START at all,
 * before it may load Prisma: lib/jibri-stop-config.ts.)
 *
 * Modes:
 * - "off" (also: no row): nothing new is armed and the worker does no fence
 *   work. Fences already open STAY enforced (never silently dropped): they
 *   need the worker (mode on / drain) or an administrator's override.
 * - "on": the tab-close signal and the departure arm fences; the worker
 *   stops (once) and verifies.
 * - "drain": nothing new is armed and no STOP is sent; the worker only
 *   observes and verifies the fences still open (the safe way down).
 *
 * What the worker reports, each written separately (one never stands in for
 * another):
 * - LIVENESS (heartbeatAt): its own timer, every few seconds, with the mode
 *   it saw and its IDENTITY (version, Jitsi target, JWT issuer / audience,
 *   a non-reversible fingerprint of the JWT secret).
 * - SWEEP PROGRESS (sweepStartedAt, sweepCompletedAt): each sweep, which is
 *   time-boxed (lib/jibri-stop-for-departure.ts), so a long sweep never
 *   looks like a dead worker and a stuck one is still seen.
 * - CONNECTION PROOF (lastXmppAuthAt, lastRoomJoinAt, lastConnectionError):
 *   a login to the EXPECTED server (its bound JID's domain checked), a join
 *   of an expected room as a moderator, and the last failure. A heartbeat
 *   write proves the database, never Jitsi.
 *
 * Health (mode on / drain), in this order:
 *   missing / stale liveness, the app's own settings incomplete
 *   (config-unverifiable), a different worker version or configuration
 *   (version-mismatch / config-mismatch, with the differing fields), the
 *   mode not seen yet (mode-mismatch), a stalled sweep (sweep-stalled), a
 *   failing login or room join (xmpp-failing / room-join-failing), no recent
 *   login proof (xmpp-unverified). Any of these: teachers WITH an open fence
 *   get a clear 503 (lib/jibri-shutdown-gate.ts); others are not affected.
 *   Switching to "on" is refused unless the worker is ready (the same
 *   checks, the mode aside).
 *
 * Activation (in this order): 1. apply the migrations; 2. start the worker
 * process (its explicit env) and check on the admin page that it is ready
 * (it reports in every mode); 3. an administrator sets the mode to "on".
 * Rollback: 1. set "drain" (nothing new armed, no STOP); 2. wait until no
 * fence is open (or override the remaining ones, audited); 3. set "off";
 * 4. stop the worker. Never stop the worker while the mode is on / drain:
 * starts of teachers with open fences then fail (worker unavailable).
 */

export const JIBRI_FENCE_MODES = ["off", "on", "drain"] as const;

export type JibriFenceMode = (typeof JIBRI_FENCE_MODES)[number];

export const JIBRI_CONTROL_ID = "default";

/** The worker writes its liveness every 10 s; older than this is stale. */
export const JIBRI_WORKER_HEARTBEAT_STALE_MS = 60_000;

/**
 * No sweep completed for this long is a stalled sweep: above one sweep's
 * time box (JIBRI_SWEEP_BUDGET_MS, 2 min) plus one attempt in flight (40 s)
 * plus its database steps, with margin.
 */
export const JIBRI_SWEEP_STALL_MS = 300_000;

/** The worker logs in to Jitsi (a probe) every 5 min; no login proof for this long: unverified. */
export const JIBRI_XMPP_PROOF_MAX_AGE_MS = 900_000;

/** A failed room join keeps the worker degraded for this long (unless a join succeeded since). */
export const JIBRI_ROOM_JOIN_FAILURE_RELEVANCE_MS = 1_800_000;

/** Outcomes that mean the login itself failed (or reached another server). */
export const JIBRI_AUTH_ERRORS: readonly string[] = ["connect-failed", "wrong-server", "connect-timeout"];

/** Outcomes that mean the expected room could not be joined as a moderator. */
export const JIBRI_JOIN_ERRORS: readonly string[] = ["join-failed", "not-moderator", "join-timeout"];

export { JIBRI_WORKER_VERSION };

export const JIBRI_MODE_REASON_MIN = 10;
export const JIBRI_MODE_REASON_MAX = 500;

export type JibriFenceControl = {
  mode: JibriFenceMode;
  modeChangedAt: Date | null;
  modeChangedBy: string | null;
  heartbeatAt: Date | null;
  workerStartedAt: Date | null;
  workerVersion: string | null;
  workerConfigId: string | null;
  workerMode: string | null;
  workerJitsiDomain: string | null;
  workerWebsocketUrl: string | null;
  workerMucDomain: string | null;
  workerRecorderDomain: string | null;
  workerFocusJid: string | null;
  workerJwtIssuer: string | null;
  workerJwtAudience: string | null;
  workerJwtFingerprint: string | null;
  sweepStartedAt: Date | null;
  sweepCompletedAt: Date | null;
  lastXmppAuthAt: Date | null;
  lastRoomJoinAt: Date | null;
  lastConnectionError: string | null;
  lastConnectionErrorAt: Date | null;
};

const asMode = (value: unknown): JibriFenceMode =>
  (JIBRI_FENCE_MODES as readonly string[]).includes(value as string) ? (value as JibriFenceMode) : "off";

const CONTROL_FIELDS = [
  "modeChangedAt", "modeChangedBy", "heartbeatAt", "workerStartedAt", "workerVersion", "workerConfigId", "workerMode",
  "workerJitsiDomain", "workerWebsocketUrl", "workerMucDomain", "workerRecorderDomain", "workerFocusJid",
  "workerJwtIssuer", "workerJwtAudience", "workerJwtFingerprint", "sweepStartedAt", "sweepCompletedAt",
  "lastXmppAuthAt", "lastRoomJoinAt", "lastConnectionError", "lastConnectionErrorAt",
] as const;

/** The shared control (no row: mode off, nothing reported). Throws on a database error. */
export async function readJibriFenceControl(): Promise<JibriFenceControl> {
  const row = await prisma.jibriShutdownControl.findUnique({ where: { id: JIBRI_CONTROL_ID } }) as Record<string, unknown> | null;
  const control = { mode: asMode(row?.mode) } as Record<string, unknown>;

  for (const field of CONTROL_FIELDS) control[field] = row?.[field] ?? null;

  return control as JibriFenceControl;
}

/** The worker's identity as it reported it (the control's columns). */
export function reportedJibriWorkerIdentity(control: Partial<JibriFenceControl>): Partial<Record<JibriIdentityField, string | null>> {
  return {
    workerVersion: control.workerVersion ?? null,
    jitsiDomain: control.workerJitsiDomain ?? null,
    websocketUrl: control.workerWebsocketUrl ?? null,
    mucDomain: control.workerMucDomain ?? null,
    recorderDomain: control.workerRecorderDomain ?? null,
    focusJid: control.workerFocusJid ?? null,
    jwtIssuer: control.workerJwtIssuer ?? null,
    jwtAudience: control.workerJwtAudience ?? null,
    jwtSecretFingerprint: control.workerJwtFingerprint ?? null,
  };
}

export type JibriWorkerProblem =
  | "missing"
  | "stale"
  | "config-unverifiable"
  | "version-mismatch"
  | "config-mismatch"
  | "mode-mismatch"
  | "sweep-stalled"
  | "xmpp-failing"
  | "room-join-failing"
  | "xmpp-unverified";

export type JibriWorkerHealth =
  | { healthy: true }
  | {
    healthy: false;
    /** unavailable: not running or not ours; degraded: running, but its work cannot be trusted now. */
    status: "unavailable" | "degraded";
    reason: JibriWorkerProblem;
    /** config-mismatch / version-mismatch: the identity fields that differ (names only). */
    fields?: JibriIdentityField[];
    /** xmpp-failing / room-join-failing: the outcome code. */
    error?: string;
  };

const unavailable = (reason: JibriWorkerProblem, extra: object = {}): JibriWorkerHealth =>
  ({ healthy: false, status: "unavailable", reason, ...extra });
const degraded = (reason: JibriWorkerProblem, extra: object = {}): JibriWorkerHealth =>
  ({ healthy: false, status: "degraded", reason, ...extra });

const olderThan = (at: Date | null | undefined, now: Date, ms: number) => !at || now.getTime() - at.getTime() > ms;
const after = (a: Date | null | undefined, b: Date | null | undefined) => Boolean(a) && (!b || (a as Date).getTime() > b.getTime());

/**
 * Whether the worker can do the fence's work at all, the mode aside (also
 * the condition for switching to "on"). `expected`: the app's own view of
 * the identity (default: from this process's environment).
 */
export function jibriWorkerReadiness(
  control: Partial<JibriFenceControl>,
  now: Date,
  expected: ReturnType<typeof expectedJibriWorkerIdentity> = expectedJibriWorkerIdentity(process.env)
): JibriWorkerHealth {
  if (!control.heartbeatAt) return unavailable("missing");
  if (olderThan(control.heartbeatAt, now, JIBRI_WORKER_HEARTBEAT_STALE_MS)) return unavailable("stale");
  if (!expected.identity) return unavailable("config-unverifiable");

  const differing = diffJibriWorkerIdentity(expected.identity as JibriWorkerIdentity, reportedJibriWorkerIdentity(control));

  if (differing.includes("workerVersion")) return unavailable("version-mismatch", { fields: differing });
  if (differing.length > 0) return unavailable("config-mismatch", { fields: differing });

  // Progress since the latest of: the last completed sweep, the worker's start (a fresh worker gets one stall period).
  const progress = [control.sweepCompletedAt, control.workerStartedAt]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  if (olderThan(progress, now, JIBRI_SWEEP_STALL_MS)) return unavailable("sweep-stalled");

  const error = control.lastConnectionError ?? null;
  const errorAt = control.lastConnectionErrorAt ?? null;

  if (error && JIBRI_AUTH_ERRORS.includes(error) && after(errorAt, control.lastXmppAuthAt)) {
    return degraded("xmpp-failing", { error });
  }

  if (error && JIBRI_JOIN_ERRORS.includes(error) && after(errorAt, control.lastRoomJoinAt) &&
    !olderThan(errorAt, now, JIBRI_ROOM_JOIN_FAILURE_RELEVANCE_MS)) {
    return degraded("room-join-failing", { error });
  }

  if (olderThan(control.lastXmppAuthAt, now, JIBRI_XMPP_PROOF_MAX_AGE_MS)) return degraded("xmpp-unverified");

  return { healthy: true };
}

/**
 * Whether the worker is doing its work for the current mode. With the mode
 * off no worker is needed ("healthy" here means: nothing is expected of it).
 */
export function jibriWorkerHealth(
  control: Partial<JibriFenceControl> & { mode: JibriFenceMode },
  now: Date,
  expected?: ReturnType<typeof expectedJibriWorkerIdentity>
): JibriWorkerHealth {
  if (control.mode === "off") return { healthy: true };

  const readiness = jibriWorkerReadiness(control, now, expected);

  if (!readiness.healthy && readiness.status === "unavailable") return readiness;
  if (control.workerMode !== control.mode) return degraded("mode-mismatch");

  return readiness;
}

/** Field names safe to show with values (the fingerprint is shown as matches / differs only). */
export const isSecretIdentityField = (field: JibriIdentityField) => JIBRI_SECRET_IDENTITY_FIELDS.includes(field);

/** The mode in which new fences are armed (the signal's provisional fence, the departure). */
export const armsFences = (mode: JibriFenceMode) => mode === "on";

async function writeControl(data: Record<string, unknown>): Promise<void> {
  await prisma.jibriShutdownControl.upsert({
    where: { id: JIBRI_CONTROL_ID },
    create: { id: JIBRI_CONTROL_ID, mode: "off", ...data },
    update: data,
  });
}

/** The worker is alive (its own timer): the mode it saw and its identity. */
export async function recordJibriWorkerLiveness(input: {
  at: Date;
  mode: JibriFenceMode;
  startedAt: Date;
  configId: string;
  identity: JibriWorkerIdentity;
}): Promise<void> {
  const { identity } = input;

  await writeControl({
    heartbeatAt: input.at,
    workerStartedAt: input.startedAt,
    workerMode: input.mode,
    workerConfigId: input.configId,
    workerVersion: identity.workerVersion,
    workerJitsiDomain: identity.jitsiDomain,
    workerWebsocketUrl: identity.websocketUrl,
    workerMucDomain: identity.mucDomain,
    workerRecorderDomain: identity.recorderDomain,
    workerFocusJid: identity.focusJid,
    workerJwtIssuer: identity.jwtIssuer,
    workerJwtAudience: identity.jwtAudience,
    workerJwtFingerprint: identity.jwtSecretFingerprint,
  });
}

/** A sweep completed (it began at `startedAt`). */
export async function recordJibriSweepProgress(input: { startedAt: Date; completedAt: Date }): Promise<void> {
  await writeControl({ sweepStartedAt: input.startedAt, sweepCompletedAt: input.completedAt });
}

/**
 * What a connection to Jitsi proved (a probe or an attempt): a login to the
 * expected server, a join of the expected room as a moderator, or the
 * failure (an outcome code). Nothing is written for an attempt that never
 * tried to connect.
 */
export async function recordJibriConnectionProof(input: {
  at: Date;
  authenticated: boolean;
  roomJoined: boolean;
  error: string | null;
}): Promise<void> {
  const data: Record<string, unknown> = {};

  if (input.authenticated) data.lastXmppAuthAt = input.at;
  if (input.roomJoined) data.lastRoomJoinAt = input.at;
  if (input.error) {
    data.lastConnectionError = input.error;
    data.lastConnectionErrorAt = input.at;
  }

  if (Object.keys(data).length > 0) await writeControl(data);
}

/**
 * An administrator changes the mode (reason required; audited). Switching to
 * "on" needs a ready worker (jibriWorkerReadiness): 409 JIBRI_WORKER_NOT_READY
 * otherwise, with the reason and (for a configuration difference) the
 * fields. "drain" and "off" are always allowed (the safe directions).
 */
export async function setJibriFenceMode(input: {
  mode: unknown;
  reason: unknown;
  admin: { adminId: string; email?: string | null };
}): Promise<{ fromMode: JibriFenceMode; toMode: JibriFenceMode }> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";

  if (!input.admin?.adminId) throw new AppError("Admin privileges are required.", 403, "FORBIDDEN");

  if (!(JIBRI_FENCE_MODES as readonly string[]).includes(input.mode as string)) {
    throw new AppError("Mode must be off, on or drain.", 400, "JIBRI_MODE_INVALID");
  }

  if (reason.length < JIBRI_MODE_REASON_MIN || reason.length > JIBRI_MODE_REASON_MAX) {
    throw new AppError(
      `A reason of ${JIBRI_MODE_REASON_MIN} to ${JIBRI_MODE_REASON_MAX} characters is required.`,
      400,
      "JIBRI_MODE_REASON_REQUIRED"
    );
  }

  const toMode = input.mode as JibriFenceMode;
  const now = await serverNow();

  return prisma.$transaction(async tx => {
    const row = await tx.jibriShutdownControl.findUnique({ where: { id: JIBRI_CONTROL_ID } });
    const fromMode = asMode(row?.mode);

    if (toMode === "on" && fromMode !== "on") {
      const readiness = jibriWorkerReadiness((row ?? {}) as Partial<JibriFenceControl>, now);

      if (!readiness.healthy) {
        const detail = readiness.fields?.length ? ` (${readiness.fields.join(", ")})` : readiness.error ? ` (${readiness.error})` : "";

        throw new AppError(
          `The Jibri stop worker is not ready: ${readiness.reason}${detail}. Fix it before switching the mode to on.`,
          409,
          "JIBRI_WORKER_NOT_READY"
        );
      }
    }

    await tx.jibriShutdownControl.upsert({
      where: { id: JIBRI_CONTROL_ID },
      create: { id: JIBRI_CONTROL_ID, mode: toMode, modeChangedAt: now, modeChangedBy: input.admin.adminId },
      update: { mode: toMode, modeChangedAt: now, modeChangedBy: input.admin.adminId },
    });

    await tx.jibriShutdownModeChange.create({
      data: { fromMode, toMode, adminId: input.admin.adminId, adminEmail: input.admin.email ?? null, reason },
    });

    console.warn("Jibri shutdown fence mode changed by an administrator", { fromMode, toMode, adminId: input.admin.adminId });

    return { fromMode, toMode };
  });
}
