import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { encryptYouTubeToken } from "@/lib/youtube-crypto";
import { prisma } from "@/lib/prisma";
import { youtubeFetch } from "@/lib/youtube-request";
import { saveYouTubeConnection } from "@/lib/youtube-connection";

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

    /*
     * Behind a reverse proxy, request.url can carry the internal host
     * (localhost:3000). Google called us back on the origin registered in
     * GOOGLE_YOUTUBE_REDIRECT_URI, so that origin is the public domain the
     * teacher is actually on (localhost in dev, slclassroom.live in prod).
     */
    function getPublicOrigin() {
        if (redirectUri) {
            try {
                return new URL(redirectUri).origin;
            } catch {
                // fall through to header-based detection
            }
        }

        const host =
            request.headers.get("x-forwarded-host") ??
            request.headers.get("host");
        const proto =
            request.headers.get("x-forwarded-proto") ??
            new URL(request.url).protocol.replace(":", "");

        return host ? `${proto}://${host}` : new URL(request.url).origin;
    }

    const publicOrigin = getPublicOrigin();

    function redirectWithError(errorCode: string) {
        const url = new URL(safeReturnTo, publicOrigin);
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
    const tokenResponse = await youtubeFetch(
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
    ).catch((error: unknown) => {
        // Network failure or timeout (youtubeFetch): no tokens.
        console.error("YouTube OAuth token exchange did not complete:", error);
        return null;
    });

    if (!tokenResponse) {
        return redirectWithError("TOKEN_EXCHANGE_FAILED");
    }

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
    const channelResponse = await youtubeFetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    ).catch((error: unknown) => {
        console.error("YouTube channel lookup did not complete:", error);
        return null;
    });

    if (!channelResponse) {
        return redirectWithError("CHANNEL_LOOKUP_FAILED");
    }

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
     * Save the teacher's YouTube connection (a different channel than before
     * also clears the saved reusable stream: it belongs to the old channel).
     */
    await saveYouTubeConnection(teacherSession.teacherId, {
        channelId,
        channelTitle,
        refreshTokenEncrypted,
    });

    /*
     * Redirect teacher back to where
     * they started the YouTube connection.
     */
    const response = NextResponse.redirect(
        new URL(
            safeReturnTo,
            publicOrigin
        )
    );

    response.cookies.delete(
        "youtube_oauth_state"
    );

    return response;
}
