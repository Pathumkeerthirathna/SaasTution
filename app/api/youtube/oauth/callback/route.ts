import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { encryptYouTubeToken } from "@/lib/youtube-crypto";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
    const teacherSession = await requireTeacherSession();

    const clientId = process.env.GOOGLE_YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_YOUTUBE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_YOUTUBE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        return NextResponse.json(
            {
                error: "YouTube OAuth configuration is missing.",
            },
            { status: 500 }
        );
    }

    const { searchParams } = new URL(request.url);

    const code = searchParams.get("code");
    const returnedState = searchParams.get("state");
    const error = searchParams.get("error");

    // Teacher denied authorization
    if (error) {
        return NextResponse.json(
            {
                error: "YouTube authorization was not completed.",
                details: error,
            },
            { status: 400 }
        );
    }

    if (!code || !returnedState) {
        return NextResponse.json(
            {
                error: "Missing authorization code or state.",
            },
            { status: 400 }
        );
    }

    // Verify OAuth state
    const storedState =
        request.cookies.get("youtube_oauth_state")?.value;

    if (!storedState || storedState !== returnedState) {
        return NextResponse.json(
            {
                error: "Invalid OAuth state.",
            },
            { status: 400 }
        );
    }

    // Exchange authorization code for Google tokens
    const tokenResponse = await fetch(
        "https://oauth2.googleapis.com/token",
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
            }),
        }
    );

    if (!tokenResponse.ok) {
        const errorDetails = await tokenResponse.text();

        console.error(
            "YouTube OAuth token exchange failed:",
            errorDetails
        );

        return NextResponse.json(
            {
                error:
                    "Failed to exchange authorization code.",
            },
            { status: 500 }
        );
    }

    const tokenData = await tokenResponse.json();

    const accessToken = tokenData.access_token as
        | string
        | undefined;

    const refreshToken = tokenData.refresh_token as
        | string
        | undefined;

    if (!accessToken) {
        return NextResponse.json(
            {
                error:
                    "Google did not return an access token.",
            },
            { status: 500 }
        );
    }

    /*
     * Get the YouTube channel belonging to the
     * Google account that just authorized SLClassroom.
     */
    const channelResponse = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    if (!channelResponse.ok) {
        const errorDetails =
            await channelResponse.text();

        console.error(
            "YouTube channel lookup failed:",
            errorDetails
        );

        return NextResponse.json(
            {
                error:
                    "Unable to retrieve the YouTube channel.",
            },
            { status: 500 }
        );
    }

    const channelData = await channelResponse.json();

    const channel = channelData.items?.[0];

    if (!channel?.id) {
        return NextResponse.json(
            {
                error:
                    "No YouTube channel was found for this Google account.",
            },
            { status: 400 }
        );
    }

    const channelId = channel.id as string;

    const channelTitle =
        channel.snippet?.title as string | undefined;

    /*
     * If the teacher already has a YouTube connection,
     * Google may not return a new refresh token.
     *
     * In that case, keep the existing refresh token.
     */
    const existingConnection =
        await prisma.youTubeConnection.findUnique({
            where: {
                teacherId: teacherSession.teacherId,
            },
        });

    let refreshTokenEncrypted =
        existingConnection?.refreshTokenEncrypted;

    if (refreshToken) {
        refreshTokenEncrypted =
            encryptYouTubeToken(refreshToken);
    }

    if (!refreshTokenEncrypted) {
        return NextResponse.json(
            {
                error:
                    "Google did not provide a refresh token. Please reconnect YouTube and grant offline access.",
            },
            { status: 400 }
        );
    }

    /*
     * Save the teacher's YouTube connection.
     */
    await prisma.youTubeConnection.upsert({
        where: {
            teacherId: teacherSession.teacherId,
        },
        create: {
            teacherId: teacherSession.teacherId,
            channelId,
            channelTitle,
            refreshTokenEncrypted,
        },
        update: {
            channelId,
            channelTitle,
            refreshTokenEncrypted,
        },
    });

    // OAuth state is no longer needed.
    const response = NextResponse.json({
        success: true,
        message:
            "YouTube channel connected successfully.",
        teacherId: teacherSession.teacherId,
        channelId,
        channelTitle,
    });

    response.cookies.delete("youtube_oauth_state");

    return response;
}