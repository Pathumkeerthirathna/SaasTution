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

import { YouTubeBroadcastStatus, YouTubePrivacy } from "@prisma/client";



export async function startYouTubeLecture(
    teacherId: string,
    lectureId: string,
    privacy: "public" | "unlisted" | "private"
) {
    const result = await startYouTubeLectureInternal(teacherId, lectureId, privacy);

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
    privacy: "public" | "unlisted" | "private"
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
    let liveStreamId = connection.liveStreamId;

    if (!liveStreamId) {
        console.log(
            "🆕 No reusable YouTube stream found. Creating one..."
        );

        const newLiveStream =
            await createYouTubeLiveStream(
                connection.refreshTokenEncrypted
            );

        if (!newLiveStream.id) {
            throw new Error(
                "YouTube did not return a reusable live stream ID."
            );
        }

        liveStreamId = newLiveStream.id;

        await prisma.youTubeConnection.update({
            where: {
                teacherId,
            },
            data: {
                liveStreamId,
            },
        });

        console.log(
            "✅ Reusable YouTube stream created and saved:",
            liveStreamId
        );
    }

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

    if (existingLiveBroadcast) {
        try {
            const existingBroadcast =
                await getYouTubeLiveBroadcast(
                    connection.refreshTokenEncrypted,
                    existingLiveBroadcast.broadcastId
                );

            const lifecycleStatus =
                existingBroadcast.status
                    ?.lifeCycleStatus;

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

                    await prisma.youTubeLiveBroadcast.update({
                        where: {
                            id:
                                existingLiveBroadcast.id,
                        },
                        data: {
                            privacy:
                                youtubePrivacy,
                        },
                    });
                }

                /*
                * Keep our database status synchronized.
                */
                await prisma.youTubeLiveBroadcast.update({
                    where: {
                        id:
                            existingLiveBroadcast.id,
                    },
                    data: {
                        status:
                            lifecycleStatus === "live"
                                ? YouTubeBroadcastStatus.LIVE
                                : YouTubeBroadcastStatus.READY,
                    },
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
                };
            }

            /*
            * YouTube says the broadcast is complete.
            * Mark our database row as complete.
            */
            if (
                lifecycleStatus === "complete"
            ) {
                await prisma.youTubeLiveBroadcast.update({
                    where: {
                        id:
                            existingLiveBroadcast.id,
                    },
                    data: {
                        status:
                            YouTubeBroadcastStatus.COMPLETE,

                        endedAt:
                            new Date(),
                    },
                });
            }

        } catch (error) {
            console.warn(
                "⚠️ Existing YouTube LIVE broadcast could not be retrieved. A new one will be created.",
                {
                    liveBroadcastId:
                        existingLiveBroadcast.id,

                    broadcastId:
                        existingLiveBroadcast.broadcastId,
                }
            );
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


            try {

                const recordingBroadcast =
                    await getYouTubeLiveBroadcast(
                        connection.refreshTokenEncrypted,

                        activeRecording.broadcastId
                    );


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
                         * Jitsi/Jibri is already
                         * streaming because the
                         * recording is active.
                         */
                        alreadyStreaming:
                            true,

                        alreadyStarted:
                            lifecycleStatus ===
                            "live",

                        reusedRecording:
                            true,
                    };
                }

            } catch (error) {

                console.warn(
                    "⚠️ Could not retrieve active recording broadcast. A new Live broadcast will be created.",
                    {
                        recordingId:
                            activeRecording.id,

                        broadcastId:
                            activeRecording.broadcastId,
                    }
                );
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
    };
}

export async function startYouTubeRecording(
    teacherId: string,
    lectureId: string,
    isLive: boolean
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

    let liveStreamId = connection.liveStreamId;

    if (!liveStreamId) {
        console.log(
            "🆕 No reusable YouTube stream found. Creating one..."
        );

        const newLiveStream =
            await createYouTubeLiveStream(
                connection.refreshTokenEncrypted
            );

        if (!newLiveStream.id) {
            throw new Error(
                "YouTube did not return a reusable live stream ID."
            );
        }

        liveStreamId = newLiveStream.id;

        await prisma.youTubeConnection.update({
            where: {
                teacherId,
            },
            data: {
                liveStreamId,
            },
        });

        console.log(
            "✅ Reusable YouTube stream created and saved:",
            liveStreamId
        );
    }

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

    if (existingRecording) {
        try {
            const existingBroadcast =
                await getYouTubeLiveBroadcast(
                    connection.refreshTokenEncrypted,
                    existingRecording.broadcastId
                );

            const lifecycleStatus =
                existingBroadcast.status
                    ?.lifeCycleStatus;

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
                };
            }

            /*
            * The broadcast is no longer usable.
            * Mark our recording as complete if YouTube
            * says it is complete.
            */
            if (
                lifecycleStatus === "complete"
            ) {
                await prisma.youTubeRecording.update({
                    where: {
                        id: existingRecording.id,
                    },
                    data: {
                        status:
                            YouTubeBroadcastStatus.COMPLETE,

                        endedAt:
                            new Date(),
                    },
                });
            }

        } catch (error) {
            console.warn(
                "⚠️ Existing recording broadcast could not be retrieved. A new one will be created.",
                {
                    recordingId:
                        existingRecording.id,

                    broadcastId:
                        existingRecording.broadcastId,
                }
            );
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

    if (!recording) {
        throw new Error(
            "No YouTube recording broadcast exists."
        );
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
        console.log(
            "🆕 No reusable YouTube stream found. Creating one..."
        );

        const newLiveStream =
            await createYouTubeLiveStream(
                connection.refreshTokenEncrypted
            );

        if (!newLiveStream.id) {
            throw new Error(
                "YouTube did not return a reusable live stream ID."
            );
        }

        liveStreamId =
            newLiveStream.id;

        await prisma.youTubeConnection.update({
            where: {
                teacherId,
            },
            data: {
                liveStreamId,
            },
        });
    }

    const liveStream =
        await getYouTubeLiveStream(
            connection.refreshTokenEncrypted,
            liveStreamId
        );

    /*
     * Get THIS particular recording broadcast.
     */
    const broadcast =
        await getYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            recording.broadcastId
        );

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
     */
    if (
        broadcastStatus === "live" &&
        recording.status !==
            YouTubeBroadcastStatus.LIVE
    ) {
        await prisma.youTubeRecording.update({
            where: {
                id: recording.id,
            },
            data: {
                status:
                    YouTubeBroadcastStatus.LIVE,
            },
        });
    }

    if (
        broadcastStatus === "complete" &&
        recording.status !==
            YouTubeBroadcastStatus.COMPLETE
    ) {
        await prisma.youTubeRecording.update({
            where: {
                id: recording.id,
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

export async function updateYouTubeLiveBroadcastPrivacyForTeacher(
    teacherId: string,
    liveBroadcastId: string,
    privacy: "public" | "unlisted" | "private"
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

    await updateYouTubeLiveBroadcastPrivacy(
        connection.refreshTokenEncrypted,
        liveBroadcast.broadcastId,
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
}