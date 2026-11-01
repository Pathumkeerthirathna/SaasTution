import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { ACTIVE_FEATURE_STATUSES, type YouTubeFeature } from "@/lib/youtube-feature-state";
import {
  endYouTubeFeaturesForDepartedTeacher,
  type TeacherDeparturePendingReason,
} from "@/lib/youtube-feature-lifecycle";
import { recordTeacherActivity } from "@/lib/teacher-presence";
import { serverNow } from "@/lib/server-clock";
import { ensureSessionAccessForTeacher } from "@/services/session-service";
import { teacherFenceStatus } from "@/lib/jibri-shutdown-gate";
import { YouTubeFeatureStopReason } from "@prisma/client";

/*
 * What the teacher sees on returning to a classroom after the
 * teacher-departure stop (endYouTubeFeaturesForDepartedTeacher: the teacher
 * closed the classroom tab) ran for it.
 *
 * Only the class's own teacher, and only one class session: its Recording /
 * Live rows are the lecture's rows created while that session was the current
 * one (from its start to its end; rows of an earlier or a later session never
 * show). Confirmed stops and still-pending ones are reported separately; a
 * pending one is never described as stopped.
 */

export type DepartureStoppedNotice = {
  feature: YouTubeFeature;
  id: string;
  /** When YouTube confirmed it ended. */
  endedAt: string;
  youtubeUrl: string;
};

export type DeparturePendingNotice = {
  feature: YouTubeFeature;
  id: string;
  /** When the departure stop last sent YouTube a `complete` transition (null: none sent yet). */
  attemptedAt: string | null;
  reason: TeacherDeparturePendingReason | "unknown";
};

export type TeacherDepartureNotices = {
  sessionId: string;
  sessionActive: boolean;
  /** Confirmed TEACHER_LEFT stops the teacher has not dismissed yet. */
  stopped: DepartureStoppedNotice[];
  /** Still active: the departure stop tried and YouTube did not confirm it. */
  pending: DeparturePendingNotice[];
  /** Features of this session active right now (the stream may be theirs). */
  activeFeatures: YouTubeFeature[];
  /** A departure stop ended a feature of this session (dismissed or not). */
  hadDepartureStop: boolean;
  /**
   * The teacher's Jibri shutdown fence (lib/jibri-shutdown-gate.ts): while
   * blocked, new Recording / Live starts are refused, with this reason.
   * Absent when it could not be read.
   */
  shutdownFence?: { blocked: false } | { blocked: true; code: string; message: string; since: string | null };
};

const PENDING_REASONS: TeacherDeparturePendingReason[] = ["youtube", "timeout", "reauth-required", "shared-broadcast", "unresolved"];

type Row = {
  id: string;
  youtubeUrl: string;
  status: string;
  createdAt: Date;
  endedAt: Date | null;
  stopReason: YouTubeFeatureStopReason | null;
  autoStopAttemptedAt: Date | null;
  autoStopError: string | null;
  stopNoticeAcknowledgedAt: Date | null;
};

const rowSelect = {
  id: true,
  youtubeUrl: true,
  status: true,
  createdAt: true,
  endedAt: true,
  stopReason: true,
  autoStopAttemptedAt: true,
  autoStopError: true,
  stopNoticeAcknowledgedAt: true,
} as const;

/** The teacher's own session (404 otherwise) and its rows' time window. */
async function loadOwnedSession(teacherId: string, sessionId: string) {
  await ensureSessionAccessForTeacher(teacherId, sessionId);

  const session = await prisma.classSession.findUnique({
    where: { id: sessionId },
    select: { id: true, lectureId: true, isActive: true, startedAt: true, endedAt: true },
  });

  if (!session) {
    throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
  }

  return session;
}

/** The session's rows: the lecture's, created while it was the current session. */
async function loadSessionRows(session: { lectureId: string | null; startedAt: Date; endedAt: Date | null }) {
  if (!session.lectureId) {
    return [];
  }

  const args = {
    where: { lectureId: session.lectureId, createdAt: { gte: session.startedAt } },
    select: rowSelect,
  };

  const [recordings, lives] = await Promise.all([
    prisma.youTubeRecording.findMany(args) as Promise<Row[]>,
    prisma.youTubeLiveBroadcast.findMany(args) as Promise<Row[]>,
  ]);

  const inWindow = (row: Row) => !session.endedAt || row.createdAt < session.endedAt;

  return [
    ...recordings.filter(inWindow).map(row => ({ feature: "recording" as const, row })),
    ...lives.filter(inWindow).map(row => ({ feature: "live" as const, row })),
  ];
}

const isActiveRow = (row: Row) => (ACTIVE_FEATURE_STATUSES as string[]).includes(row.status);

/**
 * GET: the notices for the teacher's return to this session. The returning
 * classroom page asking is teacher activity: within the reload-confirmation
 * window it cancels a pending tab-close signal (a refresh); after it, it is
 * the return, and a confirmed departure not processed yet (no sweeper or
 * student ran it) is processed first, so the notices are complete.
 */
export async function getTeacherDepartureNotices(
  teacherId: string,
  sessionId: string,
  // The asking classroom page (null: it did not say).
  pageId: string | null = null,
  at?: Date
): Promise<TeacherDepartureNotices> {
  const now = at ?? await serverNow();

  const owned = await loadOwnedSession(teacherId, sessionId);

  if (owned.isActive && owned.lectureId) {
    await recordTeacherActivity(owned.id, pageId, now);
    // The teacher is looking: YouTube is asked now, whatever the retry
    // schedule (a transition is still never resent within its cooldown).
    await endYouTubeFeaturesForDepartedTeacher(owned.lectureId, now, { lookupNow: true });
  }

  // Read after processing: the rows it ended are reported now.
  const session = await loadOwnedSession(teacherId, sessionId);
  const rows = await loadSessionRows(session);

  const departed = rows.filter(({ row }) => row.stopReason === YouTubeFeatureStopReason.TEACHER_LEFT);
  const active = rows.filter(({ row }) => isActiveRow(row));

  return {
    sessionId: session.id,
    sessionActive: session.isActive,
    stopped: departed
      .filter(({ row }) => !isActiveRow(row) && !row.stopNoticeAcknowledgedAt && row.endedAt)
      .map(({ feature, row }) => ({
        feature,
        id: row.id,
        endedAt: (row.endedAt as Date).toISOString(),
        youtubeUrl: row.youtubeUrl,
      })),
    pending: active
      .filter(({ row }) => row.autoStopError !== null && row.autoStopError !== undefined)
      .map(({ feature, row }) => ({
        feature,
        id: row.id,
        attemptedAt: row.autoStopAttemptedAt ? row.autoStopAttemptedAt.toISOString() : null,
        reason: PENDING_REASONS.includes(row.autoStopError as TeacherDeparturePendingReason)
          ? (row.autoStopError as TeacherDeparturePendingReason)
          : "unknown",
      })),
    activeFeatures: Array.from(new Set(active.map(({ feature }) => feature))),
    hadDepartureStop: departed.length > 0,
    ...(await readShutdownFence(teacherId, now)),
  };
}

/** The teacher's fence status for the notices (never fails them). */
async function readShutdownFence(teacherId: string, now: Date): Promise<Pick<TeacherDepartureNotices, "shutdownFence">> {
  try {
    const status = await teacherFenceStatus(teacherId, now);

    return {
      shutdownFence: status.blocked
        ? { blocked: true, code: status.code, message: status.message, since: status.since }
        : { blocked: false },
    };
  } catch (error) {
    console.error("Could not read the teacher's Jibri shutdown fence for the notices:", { teacherId, error });
    return {};
  }
}

/** At most this many IDs per feature in one acknowledgement. */
const MAX_ACK_IDS = 20;

function parseIds(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];

  if (!Array.isArray(raw) || raw.length > MAX_ACK_IDS || !raw.every(id => typeof id === "string" && id.trim())) {
    throw new AppError(`${field} must be a list of up to ${MAX_ACK_IDS} IDs.`, 400, "VALIDATION_ERROR");
  }

  return Array.from(new Set(raw as string[]));
}

/**
 * POST: the teacher dismissed these notices. Only confirmed TEACHER_LEFT
 * stops of this session can be acknowledged; anything else (another session's
 * row, a pending or still active row, an unknown ID) is ignored. Idempotent:
 * a notice acknowledged before keeps its first time.
 */
export async function acknowledgeTeacherDepartureNotices(
  teacherId: string,
  sessionId: string,
  body: { recordingIds?: unknown; liveIds?: unknown }
): Promise<{ acknowledged: number }> {
  const ids: Record<YouTubeFeature, string[]> = {
    recording: parseIds(body.recordingIds, "recordingIds"),
    live: parseIds(body.liveIds, "liveIds"),
  };

  const session = await loadOwnedSession(teacherId, sessionId);
  const rows = await loadSessionRows(session);
  const acknowledgedAt = new Date();
  let acknowledged = 0;

  for (const feature of ["recording", "live"] as const) {
    const eligible = rows
      .filter(entry => entry.feature === feature && ids[feature].includes(entry.row.id))
      .filter(({ row }) =>
        row.stopReason === YouTubeFeatureStopReason.TEACHER_LEFT && !isActiveRow(row) && !row.stopNoticeAcknowledgedAt)
      .map(({ row }) => row.id);

    if (eligible.length === 0) continue;

    const args = {
      where: {
        id: { in: eligible },
        stopReason: YouTubeFeatureStopReason.TEACHER_LEFT,
        stopNoticeAcknowledgedAt: null,
      },
      data: { stopNoticeAcknowledgedAt: acknowledgedAt },
    };

    const result = feature === "recording"
      ? await prisma.youTubeRecording.updateMany(args)
      : await prisma.youTubeLiveBroadcast.updateMany(args);

    acknowledged += result.count;
  }

  return { acknowledged };
}
