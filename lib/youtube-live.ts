import { getYouTubeAccessToken } from "@/lib/youtube-auth";
import { YouTubeApiError, youtubeFetch } from "@/lib/youtube-request";

type YouTubeLiveStream = {
    id: string;
    snippet?: {
        title?: string;
        description?: string;
    };
    cdn?: {
        ingestionInfo?: {
            ingestionAddress?: string;
            streamName?: string;
        };
    };
    status?: {
        streamStatus?: string;
    };
};
export type YouTubeLiveBroadcast = {
    id: string;

    snippet?: {
        title?: string;
        description?: string;
        scheduledStartTime?: string;
        scheduledEndTime?: string;
        actualStartTime?: string;
        /** Set by YouTube once the broadcast has ended. */
        actualEndTime?: string;
    };

    status?: {
        lifeCycleStatus?: string;
        privacyStatus?: string;
    };

    contentDetails?: {
        boundStreamId?: string;
        boundStreamLastUpdateTimeMs?: string;

        enableAutoStart?: boolean;
        enableAutoStop?: boolean;

        monitorStream?: {
            enableMonitorStream?: boolean;
            broadcastStreamDelayMs?: number;
        };
    };
};

export async function createYouTubeLiveStream(
    encryptedRefreshToken: string
): Promise<YouTubeLiveStream> {
    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const response = await youtubeFetch(
        "https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn,contentDetails,status",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                snippet: {
                    title: "SLClassroom Live Stream",
                    description:
                        "Reusable live stream for SLClassroom classes.",
                },
                cdn: {
                    frameRate: "30fps",
                    ingestionType: "rtmp",
                    resolution: "1080p",
                },
                contentDetails: {
                    isReusable: true,
                },
            }),
        }
    );

    if (!response.ok) {
        const errorDetails =
            await response.text();

        console.error(
            "YouTube liveStream creation failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to create YouTube live stream.",
            response.status,
            errorDetails
        );
    }

    return response.json();
}

export async function getYouTubeLiveStream(
    encryptedRefreshToken: string,
    streamId: string
): Promise<YouTubeLiveStream> {
    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const url = new URL(
        "https://www.googleapis.com/youtube/v3/liveStreams"
    );

    url.searchParams.set(
        "part",
        "snippet,cdn,contentDetails,status"
    );

    url.searchParams.set(
        "id",
        streamId
    );

    const response = await youtubeFetch(
        url.toString(),
        {
            method: "GET",

            headers: {
                Authorization:
                    `Bearer ${accessToken}`,
            },
        }
    );

    if (!response.ok) {
        const errorDetails =
            await response.text();

        console.error(
            "YouTube liveStream lookup failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to retrieve YouTube live stream.",
            response.status,
            errorDetails
        );
    }

    const data = await response.json();

    const stream = data.items?.[0];

    if (!stream) {
        throw new Error(
            "YouTube live stream not found."
        );
    }

    return stream;
}

export async function createYouTubeLiveBroadcast(
    encryptedRefreshToken: string,
    options: {
        title: string;
        description?: string;
        scheduledStartTime: Date;
        privacyStatus?: "public" | "unlisted" | "private";
        enableAutoStart?: boolean;
    }
): Promise<YouTubeLiveBroadcast> {

    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const enableAutoStart =
        options.enableAutoStart ?? true;

    const response = await youtubeFetch(
        "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails",
        {
            method: "POST",

            headers: {
                Authorization:
                    `Bearer ${accessToken}`,

                "Content-Type":
                    "application/json",
            },

            body: JSON.stringify({
                snippet: {
                    title:
                        options.title,

                    description:
                        options.description ??
                        "SLClassroom online class.",

                    scheduledStartTime:
                        options.scheduledStartTime
                            .toISOString(),
                },

                status: {
                    privacyStatus:
                        options.privacyStatus ??
                        "unlisted",
                },

                contentDetails: {

                    /*
                     * If the reusable stream is already
                     * active, this will be false.
                     *
                     * If this is the first broadcast and
                     * Jitsi still needs to start streaming,
                     * this will be true.
                     */
                    enableAutoStart,

                    enableAutoStop:
                        true,

                    enableDvr:
                        true,

                    recordFromStart:
                        true,

                    /*
                     * When monitor stream is enabled,
                     * YouTube may require the broadcast
                     * to go through TESTING before LIVE.
                     *
                     * For our already-active reusable
                     * stream scenario, disable it so we
                     * can transition READY → LIVE directly.
                     */
                    monitorStream: {
                        enableMonitorStream:
                            enableAutoStart,
                        broadcastStreamDelayMs:
                            0,
                    },
                },
            }),
        }
    );

    if (!response.ok) {

        const errorDetails =
            await response.text();

        console.error(
            "YouTube liveBroadcast creation failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to create YouTube live broadcast.",
            response.status,
            errorDetails
        );
    }

    const broadcast =
        await response.json();

    console.log(
        "🆕 YOUTUBE BROADCAST CREATED:",
        {
            broadcastId:
                broadcast.id,

            enableAutoStart:
                broadcast.contentDetails
                    ?.enableAutoStart,

            enableAutoStop:
                broadcast.contentDetails
                    ?.enableAutoStop,

            enableMonitorStream:
                broadcast.contentDetails
                    ?.monitorStream
                    ?.enableMonitorStream,

            lifecycleStatus:
                broadcast.status
                    ?.lifeCycleStatus,

            privacyStatus:
                broadcast.status
                    ?.privacyStatus,
        }
    );

    return broadcast;
}


export async function bindYouTubeLiveBroadcast(
    encryptedRefreshToken: string,
    broadcastId: string,
    streamId: string
): Promise<YouTubeLiveBroadcast> {
    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const url =
        new URL(
            "https://www.googleapis.com/youtube/v3/liveBroadcasts/bind"
        );

    url.searchParams.set("part", "id,snippet,contentDetails,status");
    url.searchParams.set("id", broadcastId);
    url.searchParams.set("streamId", streamId);

    const response = await youtubeFetch(url.toString(), {
        method: "POST",

        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        const errorDetails =
            await response.text();

        console.error(
            "YouTube liveBroadcast bind failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to bind YouTube live broadcast to stream.",
            response.status,
            errorDetails
        );
    }

    return response.json();
}



export async function getYouTubeLiveBroadcast(
    encryptedRefreshToken: string,
    broadcastId: string
): Promise<YouTubeLiveBroadcast> {

    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const url = new URL(
        "https://www.googleapis.com/youtube/v3/liveBroadcasts"
    );

    url.searchParams.set(
        "part",
        "snippet,status,contentDetails"
    );

    url.searchParams.set(
        "id",
        broadcastId
    );

    const response = await youtubeFetch(
        url.toString(),
        {
            method: "GET",

            headers: {
                Authorization:
                    `Bearer ${accessToken}`,
            },
        }
    );

    if (!response.ok) {
        const errorDetails =
            await response.text();

        console.error(
            "YouTube liveBroadcast lookup failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to retrieve YouTube live broadcast.",
            response.status,
            errorDetails
        );
    }

    const data =
        await response.json();

    const items: YouTubeLiveBroadcast[] =
        Array.isArray(data.items) ? data.items : [];

    if (items.length === 0) {
        throw new Error(
            "YouTube live broadcast not found."
        );
    }

    // Only the broadcast that was asked for: an answer about any other
    // resource is invalid (never "not found", never a status to act on).
    const broadcast =
        items.find(item => item?.id === broadcastId);

    if (!broadcast) {
        console.error(
            "YouTube answered a broadcast lookup with a different resource:",
            { requested: broadcastId, returned: items.map(item => item?.id) }
        );

        throw new YouTubeApiError(
            "YouTube answered with a different broadcast than the one requested.",
            response.status
        );
    }

    return broadcast;
}

/**
 * Every broadcast this application creates has a description starting with
 * this (youtube-lecture.ts uses it for Recording and Live): the pre-start
 * cleanup only ever considers broadcasts carrying it.
 */
export const SLCLASSROOM_BROADCAST_DESCRIPTION_PREFIX = "SLClassroom - ";

/**
 * Deletes a broadcast (liveBroadcasts.delete). Used only for a broadcast a
 * fresh lookup just reported as never started (ready / created). Errors keep
 * YouTube's HTTP status and reason (YouTubeApiError: 404 not found, 403
 * liveBroadcastDeletionNotAllowed, ...); a timeout is YouTubeRequestTimeoutError.
 */
export async function deleteYouTubeLiveBroadcast(
    encryptedRefreshToken: string,
    broadcastId: string
): Promise<void> {
    const accessToken = await getYouTubeAccessToken(encryptedRefreshToken);

    const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");

    url.searchParams.set("id", broadcastId);

    const response = await youtubeFetch(url.toString(), {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        const errorDetails = await response.text();

        console.error("YouTube liveBroadcast deletion failed:", { broadcastId, status: response.status, errorDetails });

        throw new YouTubeApiError("Failed to delete YouTube live broadcast.", response.status, errorDetails);
    }
}

/** At most this many pages of 50 are read; a channel with more is refused, never partly checked. */
export const UPCOMING_BROADCAST_MAX_PAGES = 20;

/**
 * Every broadcast of the authorized channel that has not started yet
 * (liveBroadcasts.list, broadcastStatus=upcoming, all types), with its status,
 * description and bound stream, following every page. Throws (never returns a
 * partial list) when a page fails, is malformed, or there are more pages than
 * UPCOMING_BROADCAST_MAX_PAGES.
 */
export async function listUpcomingYouTubeLiveBroadcasts(
    encryptedRefreshToken: string
): Promise<YouTubeLiveBroadcast[]> {
    const accessToken = await getYouTubeAccessToken(encryptedRefreshToken);
    const broadcasts: YouTubeLiveBroadcast[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < UPCOMING_BROADCAST_MAX_PAGES; page++) {
        const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");

        url.searchParams.set("part", "id,snippet,status,contentDetails");
        url.searchParams.set("broadcastStatus", "upcoming");
        url.searchParams.set("broadcastType", "all");
        url.searchParams.set("maxResults", "50");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const response = await youtubeFetch(url.toString(), {
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        if (!response.ok) {
            const errorDetails = await response.text();

            console.error("YouTube upcoming liveBroadcasts list failed:", { status: response.status, errorDetails });

            throw new YouTubeApiError("Failed to list upcoming YouTube live broadcasts.", response.status, errorDetails);
        }

        const data = await response.json().catch(() => null);

        if (!data || !Array.isArray(data.items)) {
            throw new YouTubeApiError("YouTube answered the upcoming broadcasts list without a list.", response.status);
        }

        broadcasts.push(...data.items);

        pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;

        if (!pageToken) {
            return broadcasts;
        }
    }

    throw new Error(
        `More than ${UPCOMING_BROADCAST_MAX_PAGES * 50} upcoming YouTube broadcasts; they were not all checked.`
    );
}

export async function updateYouTubeLiveBroadcastPrivacy(
    encryptedRefreshToken: string,
    broadcastId: string,
    privacyStatus: "public" | "unlisted" | "private"
): Promise<YouTubeLiveBroadcast> {

    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const response = await youtubeFetch(
        "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status",
        {
            method: "PUT",

            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                id: broadcastId,

                status: {
                    privacyStatus,
                },
            }),
        }
    );

    if (!response.ok) {
        const errorDetails =
            await response.text();

        console.error(
            "YouTube broadcast privacy update failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to update YouTube broadcast privacy.",
            response.status,
            errorDetails
        );
    }

    return response.json();
}


export async function transitionYouTubeLiveBroadcast(
    encryptedRefreshToken: string,
    broadcastId: string,
    broadcastStatus: "testing" | "live" | "complete",
    limits: { timeoutMs?: number } = {}
): Promise<YouTubeLiveBroadcast> {

    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const url = new URL(
        "https://www.googleapis.com/youtube/v3/liveBroadcasts/transition"
    );

    url.searchParams.set(
        "broadcastStatus",
        broadcastStatus
    );

    url.searchParams.set(
        "id",
        broadcastId
    );

    url.searchParams.set(
        "part",
        "id,snippet,status,contentDetails"
    );

    // A caller may allow longer than a normal request (the teacher-departure
    // stop: youtubeTimeouts.transitionMs); still within the deadline.
    const response = await youtubeFetch(
        url.toString(),
        {
            method: "POST",
            headers: {
                Authorization:
                    `Bearer ${accessToken}`,
            },
        },
        { timeoutMs: limits.timeoutMs }
    );

    if (!response.ok) {
        const errorDetails =
            await response.text();

        console.error(
            "❌ YouTube broadcast transition failed:",
            errorDetails
        );

        throw new YouTubeApiError(
            "Failed to transition YouTube broadcast.",
            response.status,
            errorDetails
        );
    }

    return response.json();
}