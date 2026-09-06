import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { encryptYouTubeToken } from "@/lib/youtube-crypto";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
    const teacherSession = await requireTeacherSession();

    const clientId = process.env.GOOGLE_YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_YOUTUBE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_YOUTUBE_REDIRECT_URI;

    /*
     * Recover where the teacher started the connection flow from so we can
     * always bounce them back to their session, even when something below
     * goes wrong. This is only used to pick a redirect target, never to
     * grant any privileged action, so it's safe to read before the OAuth
     * state is verified.
     */
    const storedStateCookie =
        request.cookies.get("youtube_oauth_state")?.value;

    let oauthState: { state: string; returnTo: string } | null = null;

    try {
        oauthState = storedStateCookie
            ? JSON.parse(storedStateCookie)
            : null;
    } catch {
        oauthState = null;
    }

    const rawReturnTo = oauthState?.returnTo || "/";

    // Only allow redirects to internal application paths.
    const safeReturnTo =
        rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
            ? rawReturnTo
            : "/";

    function redirectWithError(errorCode: string) {
        const url = new URL(safeReturnTo, request.url);
        url.searchParams.set("youtubeOauthError", errorCode);

        const response = NextResponse.redirect(url);
        response.cookies.delete("youtube_oauth_state");
        return response;
    }

    if (!clientId || !clientSecret || !redirectUri) {
        console.error("YouTube OAuth configuration is missing.");
        return redirectWithError("CONFIG_MISSING");
    }

    const { searchParams } = new URL(request.url);

    const code = searchParams.get("code");
    const returnedState = searchParams.get("state");
    const error = searchParams.get("error");

    // Teacher denied authorization
    if (error) {
        return redirectWithError("DENIED");
    }

    if (!code || !returnedState) {
        return redirectWithError("MISSING_CODE");
    }

    // Verify OAuth state
    if (
        !storedStateCookie ||
        !oauthState ||
        !oauthState.state ||
        oauthState.state !== returnedState
    ) {
        return redirectWithError("INVALID_STATE");
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

        return redirectWithError("TOKEN_EXCHANGE_FAILED");
    }

    const tokenData = await tokenResponse.json();

    const accessToken = tokenData.access_token as
        | string
        | undefined;

    const refreshToken = tokenData.refresh_token as
        | string
        | undefined;

    if (!accessToken) {
        console.error("Google did not return an access token.");
        return redirectWithError("NO_ACCESS_TOKEN");
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

        return redirectWithError("CHANNEL_LOOKUP_FAILED");
    }

    const channelData = await channelResponse.json();

    const channel = channelData.items?.[0];

    if (!channel?.id) {
        return redirectWithError("NO_CHANNEL");
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
        return redirectWithError("NO_REFRESH_TOKEN");
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
            status: "CONNECTED",
        },
        update: {
            channelId,
            channelTitle,
            refreshTokenEncrypted,
            // A fresh refresh token clears any prior reauth requirement.
            status: "CONNECTED",
        },
    });

    /*
     * Redirect teacher back to where
     * they started the YouTube connection.
     */
    const response = NextResponse.redirect(
        new URL(
            safeReturnTo,
            request.url
        )
    );

    response.cookies.delete(
        "youtube_oauth_state"
    );

    return response;
}
