import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { emitLiveChange } from "@/lib/session-events";
import {
    createYouTubeLiveBroadcast,
    bindYouTubeLiveBroadcast,
    getYouTubeLiveStream,
    getYouTubeLiveBroadcast,
    updateYouTubeLiveBroadcastPrivacy,
    transitionYouTubeLiveBroadcast,
    createYouTubeLiveStream

} from "@/lib/youtube-live";
import type { YouTubeLiveBroadcast } from "@/lib/youtube-live";
import { YouTubeReauthorizationRequiredError } from "@/lib/youtube-auth";
import { withLectureYouTubeLock, withTeacherYouTubeLock } from "@/lib/youtube-operation-lock";
import {
    ACTIVE_FEATURE_STATUSES,
    isOtherYouTubeFeatureActive,
    type YouTubeFeature,
} from "@/lib/youtube-feature-state";
import { reconcileStaleYouTubeFeatures } from "@/lib/youtube-feature-lifecycle";

import { Prisma, YouTubeBroadcastStatus, YouTubePrivacy } from "@prisma/client";


// Shared broadcasts and active-feature helpers: see youtube-feature-state.ts
// (kept there so the lifecycle module can use them without importing this
// one). Re-exported for existing importers.
export {
    findActiveSharedFeature,
    isOtherYouTubeFeatureActive,
    type YouTubeFeature,
} from "@/lib/youtube-feature-state";

/**
 * The lecture's active Recording and Live (newest of each) and whether they
 * share one YouTube broadcast, from persisted rows only (e.g. after a reload).
 */
export async function getYouTubeFeatureState(lectureId: string) {
    const where = {
        lectureId,
        status: { in: ACTIVE_FEATURE_STATUSES },
    };
    const select = { id: true, broadcastId: true, youtubeUrl: true, privacy: true, status: true };
    const orderBy = { createdAt: "desc" as const };

    const [recording, live] = await Promise.all([
        prisma.youTubeRecording.findFirst({ where, select, orderBy }),
        prisma.youTubeLiveBroadcast.findFirst({ where, select, orderBy }),
    ]);

    return {
        recording,
        live,
        sharedBroadcastId:
            recording && live && recording.broadcastId === live.broadcastId
                ? recording.broadcastId
                : null,
    };
}

/**
 * Refuses a privacy other than Unlisted for a broadcast that is (or was) a
 * recording: Live and Recording share it, and recordings stay Unlisted.
 */
async function assertNotSharedWithRecording(
    broadcastId: string,
    privacy: "public" | "unlisted" | "private"
) {
    if (privacy === "unlisted") {
        return;
    }

    const recording = await prisma.youTubeRecording.findFirst({
        where: { broadcastId },
        select: { id: true },
    });

    if (recording) {
        throw new AppError(
            "This live stream shares its YouTube video with the class recording, so it stays Unlisted. Stop Live and start it again to use a different privacy.",
            409,
            "YOUTUBE_SHARED_BROADCAST_PRIVACY"
        );
    }
}

type ExistingBroadcastCheck =
    | {
        reusable: true;
        broadcast: YouTubeLiveBroadcast;
        lifecycleStatus: "ready" | "live";
    }
    | { reusable: false };

/**
 * Checks, on YouTube, the broadcast of an active Recording / Live row before
 * anything reuses it. Only a broadcast YouTube reports as ready or live can be
 * reused; a database row alone is never enough.
 *
 * - ready / live: reusable (the caller still checks privacy where it matters).
 * - complete / revoked, or not found on YouTube: over. The row is closed (it
 *   would otherwise keep counting as an active feature) and the caller may
 *   create a new broadcast.
 * - Any other lifecycle (created, testing, liveStarting, ...): the broadcast
 *   is changing state; refused (409) rather than reused or duplicated.
 * - A failed lookup (network, YouTube error): refused (503). Creating another
 *   broadcast behind an inconclusive answer could duplicate a live one.
 *   An expired YouTube authorization is passed on (the routes ask the teacher
 *   to reconnect).
 */
export async function checkExistingBroadcast(
    feature: YouTubeFeature,
    row: { id: string; broadcastId: string },
    refreshTokenEncrypted: string
): Promise<ExistingBroadcastCheck> {
    const closeRow = async (status: YouTubeBroadcastStatus) => {
        const where = {
            id: row.id,
            status: { in: ACTIVE_FEATURE_STATUSES },
        };
        const data = { status, endedAt: new Date() };

        if (feature === "recording") {
            await prisma.youTubeRecording.updateMany({ where, data });
        } else {
            await prisma.youTubeLiveBroadcast.updateMany({ where, data });
        }
    };

    let broadcast: YouTubeLiveBroadcast;

    try {
        broadcast = await getYouTubeLiveBroadcast(refreshTokenEncrypted, row.broadcastId);
    } catch (error) {
        if (error instanceof YouTubeReauthorizationRequiredError) {
            throw error;
        }

        if (error instanceof Error && error.message.includes("not found")) {
            console.warn("⚠️ YouTube no longer knows this broadcast; closing its row.", {
                feature,
                rowId: row.id,
                broadcastId: row.broadcastId,
            });

            await closeRow(YouTubeBroadcastStatus.REVOKED);

            return { reusable: false };
        }

        console.error("YouTube broadcast check failed; nothing reused or created:", {
            feature,
            rowId: row.id,
            broadcastId: row.broadcastId,
            error: error instanceof Error ? error.message : String(error),
        });

        throw new AppError(
            "Could not check the current YouTube broadcast. Please try again in a moment.",
            503,
            "YOUTUBE_BROADCAST_CHECK_FAILED"
        );
    }

    const lifecycleStatus = broadcast.status?.lifeCycleStatus;

    if (lifecycleStatus === "ready" || lifecycleStatus === "live") {
        return { reusable: true, broadcast, lifecycleStatus };
    }

    if (lifecycleStatus === "complete" || lifecycleStatus === "revoked") {
        await closeRow(
            lifecycleStatus === "complete"
                ? YouTubeBroadcastStatus.COMPLETE
                : YouTubeBroadcastStatus.REVOKED
        );

        return { reusable: false };
    }

    throw new AppError(
        "The current YouTube broadcast is still starting or changing state. Please try again in a moment.",
        409,
        "YOUTUBE_BROADCAST_BUSY"
    );
}

/*
 * Reuse writes. A start that reuses (or re-syncs) an existing active row writes
 * it only while it is STILL active (it is never reopened if something closed
 * it after it was read; 409, retryable), and always with a new version
 * (`version` + 1, done atomically by the database). The failed-start cleanup
 * of an earlier start compares that version (abortYouTubeFeatureStart): a
 * reused row is never closed by it. No other write changes `version`.
 */
const isRecordNotFound = (error: unknown) =>
    (error as { code?: unknown } | null)?.code === "P2025";

const featureChangedError = () =>
    new AppError(
        "The current YouTube recording or live stream changed while it was being reused. Please try again.",
        409,
        "YOUTUBE_FEATURE_CHANGED"
    );

async function reuseLiveRow(id: string, data: Prisma.YouTubeLiveBroadcastUpdateInput) {
    try {
        return await prisma.youTubeLiveBroadcast.update({
            where: { id, status: { in: ACTIVE_FEATURE_STATUSES } },
            data: { ...data, version: { increment: 1 } },
        });
    } catch (error) {
        if (isRecordNotFound(error)) throw featureChangedError();
        throw error;
    }
}

async function reuseRecordingRow(id: string, data: Prisma.YouTubeRecordingUpdateInput) {
    try {
        return await prisma.youTubeRecording.update({
            where: { id, status: { in: ACTIVE_FEATURE_STATUSES } },
            data: { ...data, version: { increment: 1 } },
        });
    } catch (error) {
        if (isRecordNotFound(error)) throw featureChangedError();
        throw error;
    }
}

const toBroadcastStatus = (lifecycleStatus: string | undefined) =>
    lifecycleStatus === "live"
        ? YouTubeBroadcastStatus.LIVE
        : YouTubeBroadcastStatus.READY;



/*
 * Start results also tell the page:
 * - rowId / ownsRow / ownsBroadcast: the feature row this start uses, whether
 *   THIS start created (or reactivated) that row, and whether it created the
 *   YouTube broadcast. A failed start cleans up only what it owns
 *   (abortYouTubeFeatureStart).
 * - startJibri: false while the other feature is already active for this
 *   lecture (its Jibri stream is running or starting). Decided under the
 *   lecture lock, so two concurrent starts never both answer true.
 */
/**
 * Authorization BEFORE the lecture lock: the lecture exists, is active
 * (status 0) and belongs to this teacher, `sessionId` is its current class
 * session (409 CLASS_SESSION_NOT_ACTIVE otherwise), and the teacher's YouTube
 * connection is not waiting for reauthorization (401). Database reads only; no YouTube
 * call and no connection change happen before them. A request for another teacher's
 * lecture therefore never takes (or waits for) that lecture's lock. The
 * start functions check again under the lock. Errors use the messages the
 * start routes already map ("Lecture not found." -> 404, "not authorized"
 * -> 403).
 */
// The lecture's current class session (the newest active one), or null.
function findActiveLectureSession(lectureId: string) {
    return prisma.classSession.findFirst({
        where: {
            lectureId,
            isActive: true,
        },
        orderBy: {
            startedAt: "desc",
        },
        select: {
            id: true,
            startedAt: true,
        },
    });
}

/**
 * The teacher's reusable YouTube stream ID, created the first time it is
 * needed. Call ONLY while holding the teacher's stream lock
 * (withTeacherYouTubeLock): the connection is read again here, so of two
 * first starts the second finds the first one's stream instead of creating
 * another. The new ID is saved only if the connection still has no stream
 * and the same channel (a reconnect to another channel meanwhile: refused,
 * retryable).
 */
async function ensureReusableStreamId(teacherId: string, refreshTokenEncrypted: string): Promise<string> {
    const current = await prisma.youTubeConnection.findUnique({
        where: {
            teacherId,
        },
        select: {
            liveStreamId: true,
            channelId: true,
        },
    });

    if (!current) {
        throw new Error("Teacher has not connected a YouTube channel.");
    }

    if (current.liveStreamId) {
        return current.liveStreamId;
    }

    console.log("🆕 No reusable YouTube stream found. Creating one...");

    const newLiveStream = await createYouTubeLiveStream(refreshTokenEncrypted);

    if (!newLiveStream.id) {
        throw new Error("YouTube did not return a reusable live stream ID.");
    }

    const saved = await prisma.youTubeConnection.updateMany({
        where: {
            teacherId,
            channelId: current.channelId,
            liveStreamId: null,
        },
        data: {
            liveStreamId: newLiveStream.id,
        },
    });

    if (saved.count !== 1) {
        throw new AppError(
            "Your YouTube connection changed while the stream was being prepared. Please try again.",
            409,
            "YOUTUBE_CONNECTION_CHANGED"
        );
    }

    console.log("✅ Reusable YouTube stream created and saved:", newLiveStream.id);

    return newLiveStream.id;
}

/**
 * The teacher's reusable stream (created if missing), under the teacher's
 * stream lock. For callers that hold no YouTube lock.
 */
export function ensureTeacherReusableStream(teacherId: string, refreshTokenEncrypted: string) {
    return withTeacherYouTubeLock(teacherId, () =>
        ensureReusableStreamId(teacherId, refreshTokenEncrypted)
    );
}

/**
 * Jitsi streams one class at a time into the teacher's ONE reusable YouTube
 * stream. Refused (409) while another lecture of this teacher has an active
 * Recording / Live in its current class session: starting here would feed
 * (or take over) that class's stream. Rows of a lecture without an active
 * session, or from before its current session, are left to that lecture's
 * own cleanup / reconciliation and do not block. Call while holding the
 * teacher's stream lock.
 *
 * A row of the other lecture's current session blocks only while YouTube
 * confirms its broadcast as ready / live (checkExistingBroadcast): a row
 * whose broadcast YouTube reports ended (complete / revoked / not found,
 * e.g. Jibri stopped and YouTube auto-stopped it) is closed there and does
 * not block. A broadcast changing state blocks; a failed lookup refuses (503)
 * and changes nothing. The rows can only be reactivated by a start, which
 * needs the teacher lock held here.
 */
async function assertStreamFreeForLecture(teacherId: string, lectureId: string) {
    const args = {
        where: {
            lectureId: { not: lectureId },
            status: { in: ACTIVE_FEATURE_STATUSES },
            lecture: { class: { teacherId } },
        },
        select: { id: true, broadcastId: true, lectureId: true, createdAt: true },
    };

    const [recordings, lives] = await Promise.all([
        prisma.youTubeRecording.findMany(args),
        prisma.youTubeLiveBroadcast.findMany(args),
    ]);

    const streamInUseError = () =>
        new AppError(
            "Your YouTube stream is already being used by a recording or live stream in another class. Stop it there before starting one here.",
            409,
            "YOUTUBE_STREAM_IN_USE"
        );

    const rows = [
        ...recordings.map(row => ({ feature: "recording" as const, ...row })),
        ...lives.map(row => ({ feature: "live" as const, ...row })),
    ];

    for (const row of rows) {
        const session = await findActiveLectureSession(row.lectureId);

        if (!session || row.createdAt < session.startedAt) {
            continue;
        }

        const connection = await prisma.youTubeConnection.findUnique({
            where: { teacherId },
            select: { refreshTokenEncrypted: true },
        });

        // Cannot ask YouTube: the row keeps blocking.
        if (!connection) {
            throw streamInUseError();
        }

        let check: ExistingBroadcastCheck;

        try {
            check = await checkExistingBroadcast(row.feature, row, connection.refreshTokenEncrypted);
        } catch (error) {
            // Still starting / changing state in the other class: in use.
            if (error instanceof AppError && error.code === "YOUTUBE_BROADCAST_BUSY") {
                throw streamInUseError();
            }

            throw error;
        }

        if (check.reusable) {
            throw streamInUseError();
        }
    }
}

const noActiveSessionError = (feature: YouTubeFeature) =>
    new AppError(
        feature === "live"
            ? "This class session is not active. Start or rejoin the current class session before going live on YouTube."
            : "This class session is not active. Start or rejoin the current class session before starting a YouTube recording.",
        409,
        "CLASS_SESSION_NOT_ACTIVE"
    );

/**
 * The classroom's own session (`sessionId`, sent by the page) must be the
 * lecture's current session: the newest active one. A page left open on an
 * ended or replaced session cannot start anything (409).
 */
async function requireCurrentSession(lectureId: string, sessionId: string, feature: YouTubeFeature) {
    const session = await findActiveLectureSession(lectureId);

    if (!session || session.id !== sessionId) {
        throw noActiveSessionError(feature);
    }

    return session;
}

/**
 * Under the start lock: `sessionId` must still be the lecture's current
 * session (checked again: it may have ended since the check before the lock).
 * Features left over from an earlier session (their cleanup did not finish)
 * are ended first; if that is not confirmed (YouTube failed or timed out),
 * nothing starts (503, retryable): a start must never reuse them, or a later
 * reconciliation would end a broadcast this session is using. An expired
 * YouTube authorization is reported as such (401, reconnect), not as
 * "pending". The start then only reuses rows of this session (created at or
 * after `sessionStartedAt`). Runs under the teacher's stream lock AND the
 * lecture lock (taken in that order): no other lecture of the teacher may be
 * using the stream (409 YOUTUBE_STREAM_IN_USE).
 */
async function startInCurrentSession<T>(
    teacherId: string,
    lectureId: string,
    sessionId: string,
    feature: YouTubeFeature,
    start: (sessionStartedAt: Date) => Promise<T>
): Promise<T> {
    const session = await requireCurrentSession(lectureId, sessionId, feature);

    const reconciliation = await reconcileStaleYouTubeFeatures(lectureId, session.startedAt);

    if (reconciliation.status === "reauth-required") {
        throw new YouTubeReauthorizationRequiredError();
    }

    if (reconciliation.status !== "done") {
        throw new AppError(
            "A recording or live stream from an earlier class session could not be ended on YouTube yet, so nothing was started. Please try again in a moment.",
            503,
            "YOUTUBE_RECONCILIATION_PENDING"
        );
    }

    await assertStreamFreeForLecture(teacherId, lectureId);

    return start(session.startedAt);
}

async function assertTeacherCanStartYouTube(
    teacherId: string,
    lectureId: string,
    sessionId: string,
    feature: YouTubeFeature
) {
    const lecture = await prisma.lecture.findFirst({
        where: {
            id: lectureId,
            status: 0,
        },
        select: {
            class: {
                select: {
                    teacherId: true,
                },
            },
        },
    });

    if (!lecture) {
        throw new Error("Lecture not found.");
    }

    if (lecture.class.teacherId !== teacherId) {
        throw new Error(
            feature === "live"
                ? "You are not authorized to start YouTube streaming for this lecture."
                : "You are not authorized to start YouTube recording for this lecture."
        );
    }

    await requireCurrentSession(lectureId, sessionId, feature);

    // Already known to need reconnecting: refused (401) without asking Google
    // again (it would answer invalid_grant every time). Reconnecting sets the
    // connection back to CONNECTED.
    const connection = await prisma.youTubeConnection.findUnique({
        where: {
            teacherId,
        },
        select: {
            status: true,
        },
    });

    if (connection?.status === "REAUTH_REQUIRED") {
        throw new YouTubeReauthorizationRequiredError();
    }
}

export async function startYouTubeLecture(
    teacherId: string,
    lectureId: string,
    privacy: "public" | "unlisted" | "private",
    // The classroom's class session (must be the lecture's current one).
    sessionId: string
) {
    await assertTeacherCanStartYouTube(teacherId, lectureId, sessionId, "live");

    // Teacher's stream lock first, then the lecture lock (see youtube-operation-lock.ts).
    const result = await withTeacherYouTubeLock(teacherId, () =>
        withLectureYouTubeLock(lectureId, async () => ({
            ...(await startInCurrentSession(teacherId, lectureId, sessionId, "live", sessionStartedAt =>
                startYouTubeLectureInternal(teacherId, lectureId, privacy, sessionStartedAt))),
            startJibri: !(await isOtherYouTubeFeatureActive("live", lectureId)),
        }))
    );

    // Push a "live is available" signal to student dashboards (no polling).
    try {
        const lec = await prisma.lecture.findUnique({
            where: { id: lectureId },
            select: { classId: true },
        });
        if (lec) emitLiveChange({ classId: lec.classId, kind: "youtube", event: "started" });
    } catch {
        /* the stream still started — the signal is best-effort */
    }

    return result;
}

async function startYouTubeLectureInternal(
    teacherId: string,
    lectureId: string,
    privacy: "public" | "unlisted" | "private",
    // Only rows of the current class session are reused (startInCurrentSession).
    sessionStartedAt: Date
) {
    // 1. Get lecture
    const lecture = await prisma.lecture.findFirst({
        where: {
            id: lectureId,
            status: 0,
        },
        include: {
            class: {
                select: {
                    teacherId: true,
                },
            },
        },
    });

    if (!lecture) {
        throw new Error("Lecture not found.");
    }

    if (lecture.class.teacherId !== teacherId) {
        throw new Error(
            "You are not authorized to start YouTube streaming for this lecture."
        );
    }

    await prisma.lecture.update({
        where: { id: lecture.id },
        data: { classStatus: "LIVE" },
    });

    // 2. Get teacher's YouTube connection
    const connection =
        await prisma.youTubeConnection.findUnique({
            where: {
                teacherId,
            },
        });

    if (!connection) {
        throw new Error(
            "Teacher has not connected a YouTube channel."
        );
    }

    // 3. Teacher must have reusable stream
    // Created once per teacher (the start holds the teacher's stream lock).
    const liveStreamId = await ensureReusableStreamId(
        teacherId,
        connection.refreshTokenEncrypted
    );

    const liveStream =
        await getYouTubeLiveStream(
            connection.refreshTokenEncrypted,
            liveStreamId
        );

    const streamName =
        liveStream.cdn?.ingestionInfo?.streamName;

    if (!streamName) {
        throw new Error(
            "YouTube reusable live stream does not have a stream key."
        );
    }

    const streamStatus =
        liveStream.status?.streamStatus;

    console.log(
        "🔴 YOUTUBE LIVE STREAM STATUS:",
        streamStatus
    );

  

    const existingLiveBroadcast =
        await prisma.youTubeLiveBroadcast.findFirst({
            where: {
                createdAt: { gte: sessionStartedAt },
                lectureId: lecture.id,
                status: {
                    in: [
                        YouTubeBroadcastStatus.READY,
                        YouTubeBroadcastStatus.LIVE,
                    ],
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });

    // Reused only when YouTube confirms it (checkExistingBroadcast); an ended
    // one is closed, a failed check is refused instead of duplicating it.
    const existingLiveCheck = existingLiveBroadcast
        ? await checkExistingBroadcast(
            "live",
            existingLiveBroadcast,
            connection.refreshTokenEncrypted
        )
        : null;

    const reusableLive =
        existingLiveCheck && existingLiveCheck.reusable
            ? existingLiveCheck
            : null;

    if (existingLiveBroadcast && reusableLive) {
        {
            const existingBroadcast =
                reusableLive.broadcast;

            const lifecycleStatus =
                reusableLive.lifecycleStatus;

            console.log(
                "🔴 EXISTING YOUTUBE LIVE BROADCAST:",
                {
                    liveBroadcastId:
                        existingLiveBroadcast.id,

                    broadcastId:
                        existingLiveBroadcast.broadcastId,

                    lifecycleStatus,

                    privacyStatus:
                        existingBroadcast.status
                            ?.privacyStatus,
                }
            );

            /*
            * If this broadcast is still usable,
            * do NOT create another one.
            */
            if (
                lifecycleStatus === "ready" ||
                lifecycleStatus === "live"
            ) {
                const currentPrivacy =
                    existingBroadcast.status
                        ?.privacyStatus;

                let finalPrivacy =
                    currentPrivacy;

                /*
                * Update privacy if teacher selected
                * something different.
                */
                // A broadcast shared with a recording stays Unlisted: its
                // privacy is never changed to suit Live (the recording would
                // change with it).
                if (currentPrivacy !== privacy) {
                    await assertNotSharedWithRecording(
                        existingLiveBroadcast.broadcastId,
                        privacy
                    );
                }

                if (
                    currentPrivacy !== privacy
                ) {
                    console.log(
                        "🔄 Updating existing LIVE broadcast privacy:",
                        {
                            from: currentPrivacy,
                            to: privacy,
                            broadcastId:
                                existingLiveBroadcast.broadcastId,
                        }
                    );

                    const updatedBroadcast =
                        await updateYouTubeLiveBroadcastPrivacy(
                            connection.refreshTokenEncrypted,
                            existingLiveBroadcast.broadcastId,
                            privacy
                        );

                    finalPrivacy =
                        updatedBroadcast.status
                            ?.privacyStatus;

                    const youtubePrivacy =
                        privacy === "public"
                            ? YouTubePrivacy.PUBLIC
                            : privacy === "private"
                                ? YouTubePrivacy.PRIVATE
                                : YouTubePrivacy.UNLISTED;

                    await reuseLiveRow(existingLiveBroadcast.id, {
                        privacy: youtubePrivacy,
                    });
                }

                /*
                * Keep our database status synchronized. A reuse write: only
                * while still active, with a new version (see reuseLiveRow).
                */
                await reuseLiveRow(existingLiveBroadcast.id, {
                    status:
                        lifecycleStatus === "live"
                            ? YouTubeBroadcastStatus.LIVE
                            : YouTubeBroadcastStatus.READY,
                });

                return {
                    broadcastId:
                        existingLiveBroadcast.broadcastId,

                    videoId:
                        existingLiveBroadcast.videoId,

                    youtubeUrl:
                        existingLiveBroadcast.youtubeUrl,

                    privacy:
                        finalPrivacy?.toUpperCase(),

                    status:
                        lifecycleStatus.toUpperCase(),

                    streamName,

                    streamStatus,

                    alreadyStreaming:
                        streamStatus === "active",

                    alreadyStarted:
                        lifecycleStatus === "live",

                    rowId:
                        existingLiveBroadcast.id,

                    ownsRow:
                        false,

                    ownsBroadcast:
                        false,
                };
            }
        }
    }

    // ============================================================
    // 4B. SPECIAL CASE:
    // UNLISTED LIVE + recording already running
    // ============================================================

    if (
        privacy === "unlisted"
    ) {

        const activeRecording =
            await prisma.youTubeRecording.findFirst({
                where: {
                    createdAt: { gte: sessionStartedAt },
                    lectureId:
                        lecture.id,

                    status: {
                        in: [
                            YouTubeBroadcastStatus.READY,
                            YouTubeBroadcastStatus.LIVE,
                        ],
                    },

                    privacy:
                        YouTubePrivacy.UNLISTED,
                },

                orderBy: {
                    createdAt: "desc",
                },
            });


        if (activeRecording) {

            console.log(
                "♻️ ACTIVE UNLISTED RECORDING FOUND. CHECKING YOUTUBE BROADCAST:",
                {
                    recordingId:
                        activeRecording.id,

                    broadcastId:
                        activeRecording.broadcastId,

                    youtubeUrl:
                        activeRecording.youtubeUrl,
                }
            );


            const recordingCheck =
                await checkExistingBroadcast(
                    "recording",
                    activeRecording,
                    connection.refreshTokenEncrypted
                );

            if (recordingCheck.reusable) {

                const recordingBroadcast =
                    recordingCheck.broadcast;


                const lifecycleStatus =
                    recordingBroadcast.status
                        ?.lifeCycleStatus;

                const privacyStatus =
                    recordingBroadcast.status
                        ?.privacyStatus;


                console.log(
                    "🎥 EXISTING RECORDING BROADCAST:",
                    {
                        broadcastId:
                            activeRecording.broadcastId,

                        lifecycleStatus,

                        privacyStatus,
                    }
                );


                /*
                 * Reuse only if YouTube confirms
                 * the recording is still usable
                 * and UNLISTED.
                 */

                if (
                    (
                        lifecycleStatus ===
                        "ready" ||

                        lifecycleStatus ===
                        "live"
                    ) &&

                    privacyStatus ===
                    "unlisted"
                ) {

                    console.log(
                        "♻️ Reusing existing UNLISTED recording broadcast as Live."
                    );

                    // Persist the Live feature on the shared broadcast, so
                    // students can discover it, a reload can restore it, and
                    // each stop ends only its own feature. One row per
                    // broadcast: a Live that ran on this broadcast before
                    // (and was stopped) is made active again.
                    const liveStatus =
                        toBroadcastStatus(lifecycleStatus);

                    const sharedLiveRow =
                        await prisma.youTubeLiveBroadcast.upsert({
                        where: {
                            broadcastId:
                                activeRecording.broadcastId,
                        },
                        create: {
                            lectureId:
                                lecture.id,
                            broadcastId:
                                activeRecording.broadcastId,
                            videoId:
                                activeRecording.videoId,
                            youtubeUrl:
                                activeRecording.youtubeUrl,
                            privacy:
                                YouTubePrivacy.UNLISTED,
                            status:
                                liveStatus,
                            ...(liveStatus === YouTubeBroadcastStatus.LIVE
                                ? { startedAt: new Date() }
                                : {}),
                        },
                        update: {
                            status:
                                liveStatus,
                            endedAt:
                                null,
                            // Reactivated by this start: a new version.
                            version: { increment: 1 },
                            ...(liveStatus === YouTubeBroadcastStatus.LIVE
                                ? { startedAt: new Date() }
                                : {}),
                        },
                    });


                    return {
                        broadcastId:
                            activeRecording.broadcastId,

                        videoId:
                            activeRecording.videoId,

                        youtubeUrl:
                            activeRecording.youtubeUrl,

                        privacy:
                            "UNLISTED",

                        status:
                            lifecycleStatus
                                .toUpperCase(),

                        streamName,

                        streamStatus,

                        /*
                         * Whether YouTube actually receives the stream.
                         * An active recording row is not proof that Jibri
                         * is streaming (it may have stopped); the page
                         * decides with `startJibri` (false here: the
                         * recording's stream) and its own Jibri state.
                         */
                        alreadyStreaming:
                            streamStatus === "active",

                        alreadyStarted:
                            lifecycleStatus ===
                            "live",

                        reusedRecording:
                            true,

                        sharedWithRecording:
                            true,

                        rowId:
                            sharedLiveRow.id,

                        // The row's version as this start left it: its failed-start cleanup acts only
                        // if no other start (e.g. another tab) has reused it since.
                        rowVersion:
                            sharedLiveRow.version,

                        ownsRow:
                            true,

                        ownsBroadcast:
                            false,
                    };
                }

            }
        }
    }



    // 5. Create NEW LIVE broadcast
    const broadcast =
        await createYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            {
                title: lecture.title,

                description:
                    `SLClassroom - ${lecture.title}`,

                scheduledStartTime:
                    new Date(
                        Date.now() + 60 * 1000
                    ),

                privacyStatus: privacy,

                /*
                * If the reusable stream is already active,
                * Jibri/Jitsi is already sending data.
                *
                * Therefore we do NOT want YouTube to
                * auto-start this broadcast.
                *
                * We will explicitly transition it to LIVE.
                */
                enableAutoStart:
                    streamStatus !== "active",
            }
        );

    if (!broadcast.id) {
        throw new Error(
            "YouTube did not return a broadcast ID."
        );
    }

    // 6. Bind LIVE broadcast to reusable stream
    const boundBroadcast =
        await bindYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            broadcast.id,
            liveStreamId
        );

    console.log(
        "🔗 NEW YOUTUBE LIVE BROADCAST BOUND:",
        {
            broadcastId:
                broadcast.id,

            boundStreamId:
                boundBroadcast.contentDetails
                    ?.boundStreamId,

            expectedStreamId:
                liveStreamId,

            reusableStreamStatus:
                streamStatus,

            lifecycle:
                boundBroadcast.status
                    ?.lifeCycleStatus,
        }
    );

    // // ============================================================
    // // 🔎 DIAGNOSTIC: GET BROADCAST AGAIN AFTER BINDING
    // // ============================================================

    // const currentLiveBroadcast =
    //     await getYouTubeLiveBroadcast(
    //         connection.refreshTokenEncrypted,
    //         broadcast.id
    //     );

    // console.log(
    //     "🔎 NEW LIVE BROADCAST BEFORE TRANSITION:",
    //     {
    //         broadcastId: broadcast.id,

    //         lifecycleStatus:
    //             currentLiveBroadcast.status
    //                 ?.lifeCycleStatus,

    //         privacyStatus:
    //             currentLiveBroadcast.status
    //                 ?.privacyStatus,

    //         boundStreamId:
    //             currentLiveBroadcast.contentDetails
    //                 ?.boundStreamId,

    //         enableAutoStart:
    //             currentLiveBroadcast.contentDetails
    //                 ?.enableAutoStart,

    //         enableAutoStop:
    //             currentLiveBroadcast.contentDetails
    //                 ?.enableAutoStop,

    //         enableMonitorStream:
    //             currentLiveBroadcast.contentDetails
    //                 ?.monitorStream
    //                 ?.enableMonitorStream,
    //     }
    // );

    /*
     * If Jitsi is already streaming through the reusable
     * YouTube stream, we must explicitly transition this
     * newly-created LIVE broadcast to LIVE.
     *
     * We do NOT start Jitsi again because the stream is
     * already active.
     */

    let finalBroadcast =
    boundBroadcast;

    if (streamStatus === "active") {

        console.log(
            "🚀 Reusable YouTube stream is already active."
        );

        console.log(
            "🚀 Transitioning NEW LIVE broadcast → LIVE:",
            {
                broadcastId:
                    broadcast.id,
            }
        );

        finalBroadcast =
            await transitionYouTubeLiveBroadcast(
                connection.refreshTokenEncrypted,
                broadcast.id,
                "live"
            );

        console.log(
            "✅ NEW LIVE BROADCAST IS LIVE:",
            {
                broadcastId:
                    finalBroadcast.id,

                lifecycleStatus:
                    finalBroadcast.status
                        ?.lifeCycleStatus,

                privacyStatus:
                    finalBroadcast.status
                        ?.privacyStatus,
            }
        );
    }

    // 7. YouTube broadcast ID is the video ID
    const videoId =
    broadcast.id;

    const youtubeUrl =
        `https://www.youtube.com/watch?v=${videoId}`;

    const youtubeLivePrivacy =
        privacy === "public"
            ? YouTubePrivacy.PUBLIC
            : privacy === "private"
                ? YouTubePrivacy.PRIVATE
                : YouTubePrivacy.UNLISTED;

    const finalLifecycleStatus =
        finalBroadcast.status
            ?.lifeCycleStatus;

    const createdLiveRow =
        await prisma.youTubeLiveBroadcast.create({
        data: {
            lectureId:
                lecture.id,

            broadcastId:
                broadcast.id,

            videoId,

            youtubeUrl,

            privacy:
                youtubeLivePrivacy,

            status:
                finalLifecycleStatus === "live"
                    ? YouTubeBroadcastStatus.LIVE
                    : YouTubeBroadcastStatus.READY,

            ...(finalLifecycleStatus === "live"
                ? {
                    startedAt:
                        new Date(),
                }
                : {}),
        },
    });

    return {
        broadcastId:
            broadcast.id,

        videoId,

        youtubeUrl,

        privacy:
            youtubeLivePrivacy,

        status:
            finalLifecycleStatus
                ?.toUpperCase() ?? "READY",

        boundStreamId:
            boundBroadcast.contentDetails
                ?.boundStreamId,

        streamName,

        streamStatus,

        alreadyStreaming:
            streamStatus === "active",

        alreadyStarted:
            finalLifecycleStatus === "live",

        rowId:
            createdLiveRow.id,

        // The row's version as this start left it: its failed-start cleanup acts only
        // if no other start (e.g. another tab) has reused it since.
        rowVersion:
            createdLiveRow.version,

        ownsRow:
            true,

        ownsBroadcast:
            true,
    };
}

/** Recording start: under the lecture lock, with the Jibri decision (see above). */
export async function startYouTubeRecording(
    teacherId: string,
    lectureId: string,
    isLive: boolean,
    // The classroom's class session (must be the lecture's current one).
    sessionId: string
) {
    await assertTeacherCanStartYouTube(teacherId, lectureId, sessionId, "recording");

    // Teacher's stream lock first, then the lecture lock (see youtube-operation-lock.ts).
    return withTeacherYouTubeLock(teacherId, () =>
        withLectureYouTubeLock(lectureId, async () => ({
            ...(await startInCurrentSession(teacherId, lectureId, sessionId, "recording", sessionStartedAt =>
                startYouTubeRecordingInternal(teacherId, lectureId, isLive, sessionStartedAt))),
            startJibri: !(await isOtherYouTubeFeatureActive("recording", lectureId)),
        }))
    );
}

async function startYouTubeRecordingInternal(
    teacherId: string,
    lectureId: string,
    // Sent by the page; the active Live is read from the database instead.
    _isLive: boolean,
    // Only rows of the current class session are reused (startInCurrentSession).
    sessionStartedAt: Date
) {
    const connection =
    await prisma.youTubeConnection.findUnique({
        where: {
            teacherId,
        },
    });

    if (!connection) {
        throw new Error(
            "Teacher has not connected a YouTube channel."
        );
    }

    // Created once per teacher (the start holds the teacher's stream lock).
    const liveStreamId = await ensureReusableStreamId(
        teacherId,
        connection.refreshTokenEncrypted
    );

    const liveStream =
        await getYouTubeLiveStream(
            connection.refreshTokenEncrypted,
            liveStreamId
        );

    const streamName =
        liveStream.cdn?.ingestionInfo?.streamName;

    if (!streamName) {
        throw new Error(
            "YouTube reusable live stream does not have a stream key."
        );
    }

    const streamStatus =
        liveStream.status?.streamStatus;

    console.log(
        "================ YOUTUBE STREAM CHECK ================"
    );

    console.log(
        "🎥 REUSABLE STREAM ID:",
        liveStreamId
    );

    console.log(
        "🎥 REUSABLE STREAM STATUS:",
        streamStatus
    );

    console.log(
        "🎥 FULL YOUTUBE STREAM STATUS:",
        liveStream.status
    );

    console.log(
        "======================================================="
    );

    const lecture = await prisma.lecture.findFirst({
        where: {
            id: lectureId,
            status: 0,
        },
        include: {
            class: {
                select: {
                    teacherId: true,
                },
            },
        },
    });

    if (!lecture) {
        throw new Error("Lecture not found.");
    }

    if (lecture.class.teacherId !== teacherId) {
        throw new Error(
            "You are not authorized to start YouTube recording for this lecture."
        );
    }

    const existingRecording =
        await prisma.youTubeRecording.findFirst({
            where: {
                createdAt: { gte: sessionStartedAt },
                lectureId: lecture.id,
                status: {
                    in: [
                        YouTubeBroadcastStatus.READY,
                        YouTubeBroadcastStatus.LIVE,
                    ],
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });

    const existingRecordingCheck = existingRecording
        ? await checkExistingBroadcast(
            "recording",
            existingRecording,
            connection.refreshTokenEncrypted
        )
        : null;

    const reusableRecording =
        existingRecordingCheck && existingRecordingCheck.reusable
            ? existingRecordingCheck
            : null;

    if (existingRecording && reusableRecording) {
        {
            const existingBroadcast =
                reusableRecording.broadcast;

            const lifecycleStatus =
                reusableRecording.lifecycleStatus;

            console.log(
                "🎥 EXISTING RECORDING BROADCAST:",
                {
                    recordingId:
                        existingRecording.id,

                    broadcastId:
                        existingRecording.broadcastId,

                    lifecycleStatus,

                    privacyStatus:
                        existingBroadcast.status
                            ?.privacyStatus,
                }
            );

            if (
                lifecycleStatus === "ready" ||
                lifecycleStatus === "live"
            ) {
                // A reuse write (as the Live reuse): only while still active,
                // with a new version, so a failed start that created this row
                // earlier (e.g. in another tab) leaves it alone.
                await reuseRecordingRow(existingRecording.id, {
                    status: toBroadcastStatus(lifecycleStatus),
                });

                return {
                    broadcastId:
                        existingRecording.broadcastId,

                    videoId:
                        existingRecording.videoId,

                    youtubeUrl:
                        existingRecording.youtubeUrl,

                    privacy:
                        existingBroadcast.status
                            ?.privacyStatus
                            ?.toUpperCase(),

                    status:
                        lifecycleStatus.toUpperCase(),

                    streamName,

                    alreadyStreaming:
                        streamStatus === "active",

                    alreadyStarted:false,

                    rowId:
                        existingRecording.id,

                    ownsRow:
                        false,

                    ownsBroadcast:
                        false,
                };
            }
        }
    }


    /*
     * Unlisted Live already running: record that same broadcast (one YouTube
     * video, no duplicate). Only an Unlisted broadcast YouTube confirms as
     * ready / live is shared; a Public or Private Live keeps its own broadcast
     * and the recording gets a separate Unlisted one below.
     */
    const activeUnlistedLive =
        await prisma.youTubeLiveBroadcast.findFirst({
            where: {
                createdAt: { gte: sessionStartedAt },
                lectureId: lecture.id,
                status: {
                    in: ACTIVE_FEATURE_STATUSES,
                },
                privacy: YouTubePrivacy.UNLISTED,
            },
            orderBy: {
                createdAt: "desc",
            },
        });

    const liveCheck = activeUnlistedLive
        ? await checkExistingBroadcast(
            "live",
            activeUnlistedLive,
            connection.refreshTokenEncrypted
        )
        : null;

    if (activeUnlistedLive && liveCheck && liveCheck.reusable) {
        {
            const liveBroadcast =
                liveCheck.broadcast;

            const lifecycleStatus =
                liveCheck.lifecycleStatus;

            if (
                (lifecycleStatus === "ready" || lifecycleStatus === "live") &&
                liveBroadcast.status?.privacyStatus === "unlisted"
            ) {
                console.log(
                    "♻️ Recording the active UNLISTED Live broadcast (shared):",
                    {
                        liveBroadcastId: activeUnlistedLive.id,
                        broadcastId: activeUnlistedLive.broadcastId,
                        lifecycleStatus,
                    }
                );

                const recordingStatus =
                    toBroadcastStatus(lifecycleStatus);

                // One recording row per broadcast: a recording of this
                // broadcast that was stopped earlier is made active again.
                const sharedRecordingRow =
                    await prisma.youTubeRecording.upsert({
                    where: {
                        broadcastId: activeUnlistedLive.broadcastId,
                    },
                    create: {
                        lectureId: lecture.id,
                        broadcastId: activeUnlistedLive.broadcastId,
                        videoId: activeUnlistedLive.videoId,
                        youtubeUrl: activeUnlistedLive.youtubeUrl,
                        privacy: YouTubePrivacy.UNLISTED,
                        status: recordingStatus,
                        ...(recordingStatus === YouTubeBroadcastStatus.LIVE
                            ? { startedAt: new Date() }
                            : {}),
                    },
                    update: {
                        status: recordingStatus,
                        endedAt: null,
                        // Reactivated by this start: a new version.
                        version: { increment: 1 },
                        ...(recordingStatus === YouTubeBroadcastStatus.LIVE
                            ? { startedAt: new Date() }
                            : {}),
                    },
                });

                return {
                    broadcastId:
                        activeUnlistedLive.broadcastId,

                    videoId:
                        activeUnlistedLive.videoId,

                    youtubeUrl:
                        activeUnlistedLive.youtubeUrl,

                    privacy:
                        YouTubePrivacy.UNLISTED,

                    status:
                        recordingStatus,

                    streamName,

                    alreadyStreaming:
                        streamStatus === "active",

                    alreadyStarted:
                        recordingStatus === YouTubeBroadcastStatus.LIVE,

                    sharedWithLive:
                        true,

                    rowId:
                        sharedRecordingRow.id,

                    // The row's version as this start left it: its failed-start cleanup acts only
                    // if no other start (e.g. another tab) has reused it since.
                    rowVersion:
                        sharedRecordingRow.version,

                    ownsRow:
                        true,

                    ownsBroadcast:
                        false,
                };
            }
        }
    }

    const broadcast =
        await createYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            {
                title: lecture.title,

                description:
                    `SLClassroom - ${lecture.title}`,

                scheduledStartTime:
                    new Date(
                        Date.now() + 60 * 1000
                    ),

                privacyStatus: "unlisted",

                // If Jitsi is already streaming to the
                // reusable YouTube stream, don't rely on
                // auto-start for this new broadcast.
                enableAutoStart:
                    streamStatus !== "active",
            }
        );

        console.log(
            "🆕 NEW RECORDING BROADCAST CREATED:",
            {
                broadcastId: broadcast.id,
                lifecycleStatus: broadcast.status?.lifeCycleStatus,
                privacyStatus: broadcast.status?.privacyStatus,
            }
        );

    if (!broadcast.id) {
        throw new Error(
            "YouTube did not return a recording broadcast ID."
        );
    }


    const boundBroadcast =
        await bindYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            broadcast.id,
            liveStreamId
        );


        console.log(
            "🔗 RECORDING BROADCAST BOUND TO STREAM:",
            {
                broadcastId: broadcast.id,
                boundStreamId:
                    boundBroadcast.contentDetails?.boundStreamId,
                expectedStreamId:
                    connection.liveStreamId,
                privacy:
                    boundBroadcast.status?.privacyStatus,
                lifecycle:
                    boundBroadcast.status?.lifeCycleStatus,
            }
        );


        let finalBroadcast =
            boundBroadcast;

        if (streamStatus === "active") {
            console.log(
                "🚀 Reusable YouTube stream is already active."
            );

            console.log(
                "🚀 Transitioning NEW recording broadcast → LIVE:",
                {
                    broadcastId: broadcast.id,
                }
            );

            finalBroadcast =
                await transitionYouTubeLiveBroadcast(
                    connection.refreshTokenEncrypted,
                    broadcast.id,
                    "live"
                );

            console.log(
                "✅ NEW RECORDING BROADCAST IS LIVE:",
                {
                    broadcastId:
                        finalBroadcast.id,

                    lifecycleStatus:
                        finalBroadcast.status
                            ?.lifeCycleStatus,

                    privacyStatus:
                        finalBroadcast.status
                            ?.privacyStatus,
                }
            );
        }


        const youtubeStatus =
        finalBroadcast.status?.lifeCycleStatus === "live"
            ? YouTubeBroadcastStatus.LIVE
            : YouTubeBroadcastStatus.READY;



    const videoId = broadcast.id;

    const youtubeUrl =
        `https://www.youtube.com/watch?v=${videoId}`;



    const youtubePrivacy = YouTubePrivacy.UNLISTED;

    // await prisma.lecture.update({
    //     where: {
    //         id: lecture.id,
    //     },
    //     data: {
    //         youtubeBroadcastId:
    //             broadcast.id,

    //         youtubeVideoId:
    //             videoId,

    //         youtubeUrl,

    //         youtubePrivacy,

    //         youtubeStatus:
    //             "READY",
    //     },
    // });

    const createdRecordingRow =
        await prisma.youTubeRecording.create({
        data: {
            lectureId: lecture.id,
            broadcastId: broadcast.id,
            videoId,
            youtubeUrl,
            privacy: YouTubePrivacy.UNLISTED,
            status: youtubeStatus,
            startedAt:
                youtubeStatus === YouTubeBroadcastStatus.LIVE
                    ? new Date()
                    : undefined,
        },
    });

    return {
        broadcastId: broadcast.id,
        videoId,
        youtubeUrl,
        privacy: youtubePrivacy,

        status:
            youtubeStatus,

        boundStreamId:
            boundBroadcast.contentDetails
                ?.boundStreamId,

        streamName,

        alreadyStreaming:
            streamStatus === "active",

        alreadyStarted:youtubeStatus === YouTubeBroadcastStatus.LIVE,

        rowId:
            createdRecordingRow.id,

        // The row's version as this start left it: its failed-start cleanup acts only
        // if no other start (e.g. another tab) has reused it since.
        rowVersion:
            createdRecordingRow.version,

        ownsRow:
            true,

        ownsBroadcast:
            true,
    };
}



export async function checkYouTubeRecordingStatus(
    teacherId: string,
    lectureId: string
) {
    const connection =
        await prisma.youTubeConnection.findUnique({
            where: {
                teacherId,
            },
        });

    if (!connection) {
        throw new Error(
            "Teacher has not connected a YouTube channel."
        );
    }

    const lecture =
        await prisma.lecture.findFirst({
            where: {
                id: lectureId,
                status: 0,
            },
            select: {
                id: true,
                class: {
                    select: { teacherId: true },
                },
            },
        });

    if (!lecture) {
        throw new Error(
            "Lecture not found."
        );
    }

    if (lecture.class.teacherId !== teacherId) {
        throw new Error(
            "You are not authorized to view this lecture's recording status."
        );
    }

    /*
     * Find the latest recording for this lecture.
     *
     * We no longer use:
     *
     * lecture.youtubeBroadcastId
     *
     * because one lecture can now have many
     * YouTube recordings.
     */
    const recording =
        await prisma.youTubeRecording.findFirst({
            where: {
                lectureId: lecture.id,

                status: {
                    in: [
                        YouTubeBroadcastStatus.READY,
                        YouTubeBroadcastStatus.LIVE,
                    ],
                },
            },

            orderBy: {
                createdAt: "desc",
            },
        });

    /*
     * No READY / LIVE recording: none was started for this lecture yet, or
     * the last one has ended. That is the normal "not recording" state, not
     * an error (the classroom page asks on every teacher join). YouTube is
     * not contacted and no reusable stream is created for it.
     */
    if (!recording) {
        return {
            recordingId:
                null,

            streamStatus:
                undefined,

            broadcastStatus:
                undefined,

            isRecording:
                false,

            privacy:
                undefined,

            broadcastId:
                null,

            videoId:
                null,

            youtubeUrl:
                null,

            streamId:
                connection.liveStreamId ?? null,
        };
    }

    /*
     * The reusable stream belongs to the teacher
     * and is shared by all recordings.
     */
    let liveStreamId =
        connection.liveStreamId;

    /*
     * If somehow the teacher doesn't have one,
     * create it.
     */
    if (!liveStreamId) {
        // Under the teacher's stream lock, like every stream creation, so it
        // never races a start into creating a second one.
        liveStreamId = await withTeacherYouTubeLock(teacherId, () =>
            ensureReusableStreamId(teacherId, connection.refreshTokenEncrypted)
        );
    }

    const liveStream =
        await getYouTubeLiveStream(
            connection.refreshTokenEncrypted,
            liveStreamId
        );

    /*
     * Get THIS particular recording broadcast.
     *
     * YouTube can end up not recognizing this broadcast at all (deleted,
     * expired, etc.) even though our row still says READY/LIVE — that must
     * not crash the status check. Treat it the same as "no longer live":
     * self-heal the row to COMPLETE and report isRecording: false.
     */
    let broadcast: YouTubeLiveBroadcast | null = null;
    let broadcastDefinitelyGone = false;

    try {
        broadcast =
            await getYouTubeLiveBroadcast(
                connection.refreshTokenEncrypted,
                recording.broadcastId
            );
    } catch (error) {
        // A "not found" response means YouTube has definitively deleted or
        // expired this broadcast — that's a real "it's over" signal, safe
        // to self-heal. Any other failure (network blip, YouTube API
        // hiccup) is inconclusive, so the recording's DB status is left
        // alone rather than risking marking a genuinely-live recording as
        // COMPLETE.
        broadcastDefinitelyGone =
            error instanceof Error &&
            error.message.includes("not found");

        console.error(
            "YouTube broadcast lookup failed while checking recording status:",
            error
        );
    }

    if (!broadcast) {
        if (
            broadcastDefinitelyGone &&
            recording.status !==
                YouTubeBroadcastStatus.COMPLETE
        ) {
            // Only while still active (a concurrent Stop may have closed it).
            await prisma.youTubeRecording.updateMany({
                where: {
                    id: recording.id,
                    status: { in: ACTIVE_FEATURE_STATUSES },
                },
                data: {
                    status:
                        YouTubeBroadcastStatus.COMPLETE,

                    endedAt:
                        new Date(),
                },
            });
        }

        return {
            recordingId:
                recording.id,

            streamStatus:
                liveStream.status?.streamStatus,

            broadcastStatus:
                undefined,

            isRecording:
                false,

            privacy:
                undefined,

            broadcastId:
                recording.broadcastId,

            videoId:
                recording.videoId,

            youtubeUrl:
                recording.youtubeUrl,

            streamId:
                liveStreamId,
        };
    }

    const streamStatus =
        liveStream.status?.streamStatus;

    const broadcastStatus =
        broadcast.status?.lifeCycleStatus;

    console.log(
        "================ YOUTUBE RECORDING STATUS ================"
    );

    console.log(
        "🎥 RECORDING ID:",
        recording.id
    );

    console.log(
        "🎥 BROADCAST ID:",
        recording.broadcastId
    );

    console.log(
        "🎥 STREAM STATUS:",
        streamStatus
    );

    console.log(
        "🎥 STREAM HEALTH:",
        liveStream.status
    );

    console.log(
        "📺 BROADCAST STATUS:",
        broadcast.status
    );

    console.log(
        "=========================================================="
    );

    /*
     * Keep our database status synchronized with YouTube.
     *
     * Only "complete" and "revoked" mean YouTube considers this broadcast
     * definitively over. Everything else — "ready", "testing", "live", and
     * transitional states like "liveStarting"/"testStarting" that a
     * broadcast passes through for a few seconds right after starting —
     * must still count as ongoing. A deny-list (rather than an allow-list
     * of "known ongoing" statuses) means a transitional status we didn't
     * anticipate never gets mistaken for "ended" and wrongly marks a
     * still-live recording as COMPLETE.
     */
    const isStillOngoingOnYoutube =
        broadcastStatus !== "complete" &&
        broadcastStatus !== "revoked";

    /*
     * The row was read before YouTube was asked; a Stop / cleanup may have
     * closed it meanwhile. Writes are conditional on its status, so a stale
     * answer never reactivates a closed row (the affected-row count says
     * whether this one still applied).
     */
    let promoted = 0;

    if (
        broadcastStatus === "live" &&
        recording.status !==
            YouTubeBroadcastStatus.LIVE
    ) {
        // A status sync, not a reuse: `version` is not touched.
        ({ count: promoted } = await prisma.youTubeRecording.updateMany({
            where: {
                id: recording.id,
                status: YouTubeBroadcastStatus.READY,
            },
            data: {
                status:
                    YouTubeBroadcastStatus.LIVE,
            },
        }));
    }

    const rowStillActive =
        promoted === 1 ||
        Boolean(await prisma.youTubeRecording.findFirst({
            where: {
                id: recording.id,
                status: { in: ACTIVE_FEATURE_STATUSES },
            },
            select: { id: true },
        }));

    if (
        !isStillOngoingOnYoutube &&
        recording.status !==
            YouTubeBroadcastStatus.COMPLETE
    ) {
        await prisma.youTubeRecording.updateMany({
            where: {
                id: recording.id,
                status: { in: ACTIVE_FEATURE_STATUSES },
            },
            data: {
                status:
                    YouTubeBroadcastStatus.COMPLETE,

                endedAt:
                    new Date(),
            },
        });
    }

    return {
        recordingId:
            recording.id,

        streamStatus,

        broadcastStatus,

        // Not recording once the row was closed (even if YouTube's answer,
        // read before that, still said otherwise).
        isRecording:
            isStillOngoingOnYoutube && rowStillActive,

        privacy:
            broadcast.status
                ?.privacyStatus,

        broadcastId:
            broadcast.id,

        videoId:
            recording.videoId,

        youtubeUrl:
            recording.youtubeUrl,

        streamId:
            liveStreamId,
    };
}

/**
 * Changes a Live broadcast's YouTube privacy (PUT
 * /api/lectures/[id]/lives/[liveId]/privacy).
 *
 * Ownership is checked first (and that the broadcast belongs to
 * `expectedLectureId`, the lecture in the URL, when given). The shared-
 * broadcast check and the change itself then run under the lecture's YouTube
 * operation lock, the same lock Recording / Live start and stop take, so a
 * Recording start cannot begin sharing this broadcast between the check and
 * the change. Another operation in progress: 409
 * YOUTUBE_OPERATION_IN_PROGRESS. This function takes the lock itself; it must
 * not be called while already holding it.
 */
export async function updateYouTubeLiveBroadcastPrivacyForTeacher(
    teacherId: string,
    liveBroadcastId: string,
    privacy: "public" | "unlisted" | "private",
    expectedLectureId?: string
) {
    const liveBroadcast = await prisma.youTubeLiveBroadcast.findUnique({
        where: {
            id: liveBroadcastId,
        },
        include: {
            lecture: {
                include: {
                    class: {
                        select: {
                            teacherId: true,
                        },
                    },
                },
            },
        },
    });

    if (!liveBroadcast) {
        throw new AppError("Live broadcast not found.", 404, "LIVE_BROADCAST_NOT_FOUND");
    }

    if (liveBroadcast.lecture.class.teacherId !== teacherId) {
        throw new AppError(
            "You are not authorized to update this live broadcast.",
            403,
            "FORBIDDEN"
        );
    }

    // The broadcast must belong to the lecture the request names.
    if (expectedLectureId !== undefined && liveBroadcast.lectureId !== expectedLectureId) {
        throw new AppError("Live broadcast not found.", 404, "LIVE_BROADCAST_NOT_FOUND");
    }

    return withLectureYouTubeLock(liveBroadcast.lectureId, async () => {
        // Read again under the lock: what counts is the broadcast as it is
        // now, not before another operation finished.
        const current = await prisma.youTubeLiveBroadcast.findUnique({
            where: {
                id: liveBroadcastId,
            },
            select: {
                broadcastId: true,
                lectureId: true,
            },
        });

        if (!current || current.lectureId !== liveBroadcast.lectureId) {
            throw new AppError("Live broadcast not found.", 404, "LIVE_BROADCAST_NOT_FOUND");
        }

        const connection = await prisma.youTubeConnection.findUnique({
            where: {
                teacherId,
            },
        });

        if (!connection) {
            throw new AppError(
                "Teacher has not connected a YouTube channel.",
                400,
                "YOUTUBE_NOT_CONNECTED"
            );
        }

        // Shared with a recording: stays Unlisted (the recording is the same video).
        await assertNotSharedWithRecording(current.broadcastId, privacy);

        await updateYouTubeLiveBroadcastPrivacy(
            connection.refreshTokenEncrypted,
            current.broadcastId,
            privacy
        );

        const youtubePrivacy =
            privacy === "public"
                ? YouTubePrivacy.PUBLIC
                : privacy === "private"
                    ? YouTubePrivacy.PRIVATE
                    : YouTubePrivacy.UNLISTED;

        return prisma.youTubeLiveBroadcast.update({
            where: {
                id: liveBroadcastId,
            },
            // Not a reuse: `version` is not touched (failed-start cleanup compares it).
            data: {
                privacy: youtubePrivacy,
            },
            select: {
                id: true,
                videoId: true,
                youtubeUrl: true,
                privacy: true,
                status: true,
                startedAt: true,
                endedAt: true,
                createdAt: true,
            },
        });
    });
}