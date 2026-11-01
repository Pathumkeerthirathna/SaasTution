import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { serverNow } from "@/lib/server-clock";
import { fenceOpen, fenceSessionSelect, type FenceSession } from "@/lib/jibri-shutdown-gate";
import { withTeacherYouTubeLock } from "@/lib/youtube-operation-lock";
import {
  isSecretIdentityField,
  jibriWorkerHealth,
  jibriWorkerReadiness,
  readJibriFenceControl,
  reportedJibriWorkerIdentity,
  type JibriFenceMode,
  type JibriWorkerHealth,
} from "@/lib/jibri-fence-control";
import {
  JIBRI_IDENTITY_FIELDS,
  diffJibriWorkerIdentity,
  expectedJibriWorkerIdentity,
  type JibriIdentityField,
} from "@/lib/jibri-stop-config";

/*
 * An administrator's explicit release of a Jibri shutdown fence
 * (lib/jibri-shutdown-gate.ts): for a shutdown the worker could not verify
 * (unresolved, the room or the stream unobservable, a Jibri left with ffmpeg
 * still running), AFTER the operator checked the Jibri server and the
 * teacher's YouTube stream themselves.
 *
 * - Only from an authenticated ADMIN session (the route calls
 *   requireAdminSession); never automatic, never by time.
 * - A reason is required (JIBRI_OVERRIDE_REASON_MIN .. MAX characters).
 * - Audited: who, when, why and the fence's state are written to the
 *   append-only JibriShutdownOverride table together with the release on
 *   the session (one short transaction, no network inside), and logged.
 * - Under the teacher's YouTube lock: never interleaves with a worker
 *   attempt or a start of that teacher (a held lock: 409, try again).
 */

export const JIBRI_OVERRIDE_REASON_MIN = 10;
export const JIBRI_OVERRIDE_REASON_MAX = 500;

export type JibriFenceAdmin = { adminId: string; email?: string | null };

export type OpenJibriFence = {
  sessionId: string;
  classId: string;
  lectureId: string | null;
  teacherId: string;
  isActive: boolean;
  fenceDepartureAt: Date;
  state: string | null;
  attempts: number;
  lastError: string | null;
  stopSentAt: Date | null;
  recorderLeftAt: Date | null;
  streamInactiveAt: Date | null;
  idleReadings: number;
  /** The pinned reusable stream (an ID, not a key or secret). */
  streamId: string | null;
  /** Who armed it: signal, departure, worker, late or start. */
  origin: string | null;
};

/**
 * One identity field as the app expects it and as the worker reported it.
 * Secret-derived fields (the JWT fingerprint) carry NO values: only whether
 * they match.
 */
export type JibriIdentityComparison = {
  field: JibriIdentityField;
  matches: boolean;
  secret: boolean;
  expected: string | null;
  reported: string | null;
};

export type JibriShutdownHealth = {
  mode: JibriFenceMode;
  modeChangedAt: Date | null;
  modeChangedBy: string | null;
  /** For the current mode. */
  worker: JibriWorkerHealth;
  /** Whether the mode may be switched to on (the same checks, the mode aside). */
  readiness: JibriWorkerHealth;
  /** Why the app cannot verify any worker (its own Jitsi settings incomplete), or null. */
  appConfigProblem: string | null;
  identity: JibriIdentityComparison[];
  heartbeatAt: Date | null;
  workerStartedAt: Date | null;
  workerVersion: string | null;
  workerConfigId: string | null;
  workerMode: string | null;
  sweepStartedAt: Date | null;
  sweepCompletedAt: Date | null;
  lastXmppAuthAt: Date | null;
  lastRoomJoinAt: Date | null;
  lastConnectionError: string | null;
  lastConnectionErrorAt: Date | null;
};

/** The shared mode and the worker's health (administrators' view; no secrets, no fingerprint). */
export async function getJibriShutdownHealth(): Promise<JibriShutdownHealth> {
  const control = await readJibriFenceControl();
  const now = await serverNow();
  const expected = expectedJibriWorkerIdentity(process.env);
  const reported = reportedJibriWorkerIdentity(control);
  const differing = expected.identity ? diffJibriWorkerIdentity(expected.identity, reported) : [...JIBRI_IDENTITY_FIELDS];

  const identity = JIBRI_IDENTITY_FIELDS.map((field): JibriIdentityComparison => {
    const secret = isSecretIdentityField(field);

    return {
      field,
      matches: !differing.includes(field),
      secret,
      expected: secret ? null : expected.identity?.[field] ?? null,
      reported: secret ? null : reported[field] ?? null,
    };
  });

  return {
    mode: control.mode,
    modeChangedAt: control.modeChangedAt,
    modeChangedBy: control.modeChangedBy,
    worker: jibriWorkerHealth(control, now, expected),
    readiness: jibriWorkerReadiness(control, now, expected),
    appConfigProblem: expected.reason,
    identity,
    heartbeatAt: control.heartbeatAt,
    workerStartedAt: control.workerStartedAt,
    workerVersion: control.workerVersion,
    workerConfigId: control.workerConfigId,
    workerMode: control.workerMode,
    sweepStartedAt: control.sweepStartedAt,
    sweepCompletedAt: control.sweepCompletedAt,
    lastXmppAuthAt: control.lastXmppAuthAt,
    lastRoomJoinAt: control.lastRoomJoinAt,
    lastConnectionError: control.lastConnectionError,
    lastConnectionErrorAt: control.lastConnectionErrorAt,
  };
}

/** Every open fence (for the administrators' view). */
export async function listOpenJibriFences(): Promise<OpenJibriFence[]> {
  const sessions = await prisma.classSession.findMany({
    where: {
      jibriStopDepartureAt: { not: null },
      jibriStopOverrideAt: null,
      jibriStopState: { notIn: ["confirmed", "not-running"] },
    },
    select: {
      id: true,
      classId: true,
      lectureId: true,
      isActive: true,
      jibriStopDepartureAt: true,
      jibriStopState: true,
      jibriStopAttemptCount: true,
      jibriStopLastError: true,
      jibriStopSentAt: true,
      jibriStopRecorderLeftAt: true,
      jibriStopStreamInactiveAt: true,
      jibriStopIdleReadingCount: true,
      jibriStopStreamId: true,
      jibriStopOrigin: true,
      class: { select: { teacherId: true } },
    },
  });

  return sessions.map(s => ({
    sessionId: s.id,
    classId: s.classId,
    lectureId: s.lectureId,
    teacherId: s.class.teacherId,
    isActive: s.isActive,
    fenceDepartureAt: s.jibriStopDepartureAt as Date,
    state: s.jibriStopState,
    attempts: s.jibriStopAttemptCount,
    lastError: s.jibriStopLastError,
    stopSentAt: s.jibriStopSentAt,
    recorderLeftAt: s.jibriStopRecorderLeftAt,
    streamInactiveAt: s.jibriStopStreamInactiveAt,
    idleReadings: s.jibriStopIdleReadingCount ?? 0,
    streamId: s.jibriStopStreamId ?? null,
    origin: s.jibriStopOrigin ?? null,
  }));
}

export async function overrideJibriShutdownFence(input: {
  sessionId: string;
  reason: unknown;
  admin: JibriFenceAdmin;
}): Promise<{ sessionId: string; overriddenAt: Date; fenceDepartureAt: Date }> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";

  if (!input.admin?.adminId) {
    throw new AppError("Admin privileges are required.", 403, "FORBIDDEN");
  }

  if (reason.length < JIBRI_OVERRIDE_REASON_MIN || reason.length > JIBRI_OVERRIDE_REASON_MAX) {
    throw new AppError(
      `A reason of ${JIBRI_OVERRIDE_REASON_MIN} to ${JIBRI_OVERRIDE_REASON_MAX} characters is required.`,
      400,
      "JIBRI_OVERRIDE_REASON_REQUIRED"
    );
  }

  const owner = await prisma.classSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, class: { select: { teacherId: true } } },
  });

  if (!owner) throw new AppError("Class session not found.", 404, "SESSION_NOT_FOUND");

  return withTeacherYouTubeLock(owner.class.teacherId, async () => {
    const session = await prisma.classSession.findUnique({
      where: { id: input.sessionId },
      select: fenceSessionSelect,
    }) as FenceSession | null;

    if (!session || !fenceOpen(session)) {
      throw new AppError("This class session has no open Jibri shutdown fence.", 409, "JIBRI_FENCE_NOT_OPEN");
    }

    const fenceDepartureAt = session.jibriStopDepartureAt as Date;
    const overriddenAt = await serverNow();

    await prisma.$transaction(async tx => {
      const { count } = await tx.classSession.updateMany({
        where: {
          id: session.id,
          jibriStopDepartureAt: fenceDepartureAt,
          jibriStopOverrideAt: null,
          jibriStopState: { notIn: ["confirmed", "not-running"] },
        },
        data: {
          jibriStopOverrideAt: overriddenAt,
          jibriStopOverrideBy: input.admin.adminId,
          jibriStopOverrideReason: reason,
          jibriStopWatchUntil: null,
        },
      });

      if (count === 0) {
        throw new AppError("The Jibri shutdown fence changed meanwhile. Please reload and try again.", 409, "JIBRI_FENCE_CHANGED");
      }

      await tx.jibriShutdownOverride.create({
        data: {
          classSessionId: session.id,
          fenceDepartureAt,
          previousState: session.jibriStopState,
          adminId: input.admin.adminId,
          adminEmail: input.admin.email ?? null,
          reason,
        },
      });
    });

    console.warn("Jibri shutdown fence overridden by an administrator", {
      sessionId: session.id,
      adminId: input.admin.adminId,
      previousState: session.jibriStopState,
      fenceDepartureAt,
    });

    return { sessionId: session.id, overriddenAt, fenceDepartureAt };
  });
}
