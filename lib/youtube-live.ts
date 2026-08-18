import { getYouTubeAccessToken } from "@/lib/youtube-auth";

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
    };

    status?: {
        lifeCycleStatus?: string;
        privacyStatus?: string;
    };

    contentDetails?: {
        boundStreamId?: string;
        boundStreamLastUpdateTimeMs?: string;
    };
};

export async function createYouTubeLiveStream(
    encryptedRefreshToken: string
): Promise<YouTubeLiveStream> {
    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const response = await fetch(
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

        throw new Error(
            "Failed to create YouTube live stream."
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

    const response = await fetch(
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

        throw new Error(
            "Failed to retrieve YouTube live stream."
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
    }
): Promise<YouTubeLiveBroadcast> {

    const accessToken =
        await getYouTubeAccessToken(
            encryptedRefreshToken
        );

    const response = await fetch(
        "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails",
        {
            method: "POST",

            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                snippet: {
                    title: options.title,

                    description:
                        options.description ??
                        "SLClassroom online class.",

                    scheduledStartTime:
                        options.scheduledStartTime.toISOString(),
                },

                status: {
                    privacyStatus:
                        options.privacyStatus ??
                        "unlisted",
                },

                contentDetails: {
                    enableAutoStart: true,
                    enableAutoStop: true,
                    enableDvr: true,
                    recordFromStart: true,
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

        throw new Error(
            "Failed to create YouTube live broadcast."
        );
    }

    return response.json();
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

    const response = await fetch(url.toString(), {
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

        throw new Error(
            "Failed to bind YouTube live broadcast to stream."
        );
    }

    return response.json();
}