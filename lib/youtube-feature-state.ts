import { prisma } from "@/lib/prisma";
import { YouTubeBroadcastStatus, YouTubeFeatureStopReason } from "@prisma/client";

/** YouTube's actualEndTime of a broadcast, or null when absent / unreadable. */
export function youTubeActualEndTime(
    broadcast: { snippet?: { actualEndTime?: string } } | null | undefined
): Date | null {
    const raw = broadcast?.snippet?.actualEndTime;
    const time = typeof raw === "string" ? Date.parse(raw) : NaN;

    return Number.isNaN(time) ? null : new Date(time);
}

/**
 * A YouTube completion this soon after a `complete` transition the
 * teacher-departure stop sent, and got no answer to, may be that transition
 * (YouTube can apply it after we stopped waiting). Also the departure's
 * minimum resend interval (TRANSITION_RESEND_COOLDOWN_MS).
 */
export const DEPARTURE_TRANSITION_APPLY_WINDOW_MS = 60_000;

/**
 * A row's last departure send (its outcome unknown when autoStopError is
 * "timeout"), and its broadcast's unconfirmed `complete` request, if any
 * (completeRequestedAt: Stop, failed-start cleanup or the departure).
 */
export type DepartureSendState = {
    autoStopAttemptedAt: Date | null;
    autoStopError: string | null;
    completeRequestedAt?: Date | null;
};

/**
 * Written by every start that creates, reuses or reactivates a feature row:
 * a new feature generation (database clock), clean of any earlier departure
 * stop's state, so an old departure never covers it, never resends for it
 * and never reports on it.
 */
export function newFeatureGeneration(now: Date) {
    return {
        generationStartedAt: now,
        stopReason: null,
        autoStopAttemptedAt: null,
        autoStopError: null,
        autoStopCheckedAt: null,
        autoStopSendCount: 0,
        autoStopLastError: null,
        stopNoticeAcknowledgedAt: null,
    };
}

/**
 * What closing an active row writes when YouTube reports its broadcast
 * COMPLETE (a status sync, a start's check, the departure stop): YouTube's
 * own end time, and who ended it:
 * - TEACHER_LEFT only if the row's last departure transition got no answer
 *   (autoStopError "timeout") and YouTube completed the broadcast within
 *   DEPARTURE_TRANSITION_APPLY_WINDOW_MS after it was sent: consistent with
 *   that request (it is only sent right after a lookup reported the
 *   broadcast live). It cannot rule out YouTube's own auto-stop completing it
 *   in that same interval. actualEndTime is YouTube's clock, the send time
 *   the database's.
 * - No reason when a `complete` we requested was still unconfirmed
 *   (completeRequestedAt) and YouTube completed the broadcast at or after
 *   that request: it may be our request (e.g. a Stop answered without
 *   confirmation, applied later) or YouTube's own end; the cause is not
 *   established, so neither is claimed. (completeRequestedAt is the database
 *   clock, actualEndTime YouTube's.)
 * - YOUTUBE_ENDED otherwise: YouTube ended it (auto-stop after the stream
 *   stopped, a Jibri failure, YouTube Studio, a YouTube-side termination).
 * - No reason without an end time from YouTube.
 *
 * What actualEndTime establishes: the moment YouTube completed the broadcast.
 * Not why, nor when the stream stopped: auto-stop completes a broadcast some
 * undocumented time after ingestion stops, so an end after the tab closed
 * never proves the departure caused it.
 */
export function youTubeEndedCloseData(
    broadcast: { snippet?: { actualEndTime?: string } } | null | undefined,
    now: Date = new Date(),
    sent?: DepartureSendState | null
): { endedAt: Date; stopReason?: YouTubeFeatureStopReason; autoStopError?: null } {
    const actualEnd = youTubeActualEndTime(broadcast);

    if (!actualEnd) return { endedAt: now };

    const sentAt = sent?.autoStopError === "timeout" ? sent.autoStopAttemptedAt : null;
    const ours = Boolean(sentAt) &&
        actualEnd.getTime() >= sentAt!.getTime() &&
        actualEnd.getTime() <= sentAt!.getTime() + DEPARTURE_TRANSITION_APPLY_WINDOW_MS;

    if (ours) {
        return { endedAt: actualEnd, stopReason: YouTubeFeatureStopReason.TEACHER_LEFT, autoStopError: null };
    }

    const requestedAt = sent?.completeRequestedAt ?? null;

    if (requestedAt && actualEnd.getTime() >= requestedAt.getTime()) {
        return { endedAt: actualEnd };
    }

    return { endedAt: actualEnd, stopReason: YouTubeFeatureStopReason.YOUTUBE_ENDED };
}

/*
 * Late `complete` protection (completeRequestedAt), per YouTube BROADCAST: a
 * `complete` transition that got no confirmed answer may still be applied by
 * YouTube at any later time (no request ID, no way to ask, no documented time
 * limit). So once one is about to be requested, every row of either feature
 * on that broadcast is marked; while any is marked, no start reuses or shares
 * the broadcast (checkExistingBroadcast with `forReuse`). Only a fresh lookup
 * reporting the broadcast complete / revoked clears it: then nothing pending
 * can affect it any more, and a restart gets a NEW broadcast (an old request
 * names the old broadcast ID only). A ready / live answer never clears it.
 * No time limit.
 */

/** Only these, reported by YouTube for the broadcast itself, confirm it has ended. */
export const isTerminalLifecycle = (lifeCycleStatus: string | null | undefined) =>
    lifeCycleStatus === "complete" || lifeCycleStatus === "revoked";

/** Before a `complete` transition for this broadcast: protect it (keeps the first unconfirmed request's time). */
export async function markCompleteRequested(broadcastId: string, now: Date) {
    const args = { where: { broadcastId, completeRequestedAt: null }, data: { completeRequestedAt: now } };

    await prisma.youTubeRecording.updateMany(args);
    await prisma.youTubeLiveBroadcast.updateMany(args);
}

/** A fresh lookup (or YouTube's own answer) reported the broadcast complete / revoked. */
export async function clearCompleteRequested(broadcastId: string) {
    const args = { where: { broadcastId, completeRequestedAt: { not: null } }, data: { completeRequestedAt: null } };

    await prisma.youTubeRecording.updateMany(args);
    await prisma.youTubeLiveBroadcast.updateMany(args);
}

/** Whether a `complete` request for this broadcast is still unconfirmed (any row, either feature, active or not). */
export async function isCompleteRequested(broadcastId: string): Promise<boolean> {
    const args = { where: { broadcastId, completeRequestedAt: { not: null } }, select: { id: true } };

    return Boolean(
        (await prisma.youTubeRecording.findFirst(args)) ?? (await prisma.youTubeLiveBroadcast.findFirst(args))
    );
}

/** A row's last departure send and pending `complete` request, for youTubeEndedCloseData (null: row gone). */
export async function findDepartureSendState(feature: YouTubeFeature, id: string): Promise<DepartureSendState | null> {
    const args = { where: { id }, select: { autoStopAttemptedAt: true, autoStopError: true, completeRequestedAt: true } };

    return feature === "recording"
        ? prisma.youTubeRecording.findFirst(args)
        : prisma.youTubeLiveBroadcast.findFirst(args);
}

/*
 * Shared broadcasts.
 *
 * Recording and Live can use the SAME Unlisted YouTube broadcast. That
 * relationship is persisted without extra columns: a YouTubeRecording row and
 * a YouTubeLiveBroadcast row with the same `broadcastId` (unique within each
 * table, so at most one row of each per broadcast). Each feature is active
 * while its own row is READY / LIVE. Stopping a feature ends only its row; the
 * YouTube broadcast is completed only when the other table has no active row
 * for it any more. A reload therefore finds the relationship in the database.
 */
export type YouTubeFeature = "recording" | "live";

export const ACTIVE_FEATURE_STATUSES: YouTubeBroadcastStatus[] = [
    YouTubeBroadcastStatus.READY,
    YouTubeBroadcastStatus.LIVE,
];

/** The OTHER feature's active row on this exact YouTube broadcast, or null. */
export async function findActiveSharedFeature(
    feature: YouTubeFeature,
    broadcastId: string
) {
    const where = {
        broadcastId,
        status: { in: ACTIVE_FEATURE_STATUSES },
    };
    const select = { id: true, lectureId: true, broadcastId: true, status: true };

    return feature === "recording"
        ? prisma.youTubeLiveBroadcast.findFirst({ where, select })
        : prisma.youTubeRecording.findFirst({ where, select });
}

/**
 * Whether the OTHER feature is still active for this lecture on any broadcast
 * (shared or separate). Jitsi runs one Jibri stream per conference, feeding
 * the teacher's one reusable YouTube stream, so Jibri may only be stopped when
 * neither feature is active any more.
 */
export async function isOtherYouTubeFeatureActive(
    feature: YouTubeFeature,
    lectureId: string
): Promise<boolean> {
    const where = {
        lectureId,
        status: { in: ACTIVE_FEATURE_STATUSES },
    };
    const select = { id: true };

    const row = feature === "recording"
        ? await prisma.youTubeLiveBroadcast.findFirst({ where, select })
        : await prisma.youTubeRecording.findFirst({ where, select });

    return Boolean(row);
}
