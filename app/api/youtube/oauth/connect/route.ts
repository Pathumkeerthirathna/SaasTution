import { requireTeacherSession } from "@/lib/auth-session";
import { randomBytes } from "crypto";
import { NextResponse } from "next/server";

export async function GET(request: Request) {

    const { searchParams } = new URL(request.url);

    const returnTo =
        searchParams.get("returnTo") || "/";

    const teacherSession = await requireTeacherSession();

    const clientId = process.env.GOOGLE_YOUTUBE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_YOUTUBE_REDIRECT_URI;

    if (!clientId || !redirectUri) {
        return NextResponse.json(
            { error: "YouTube OAuth configuration is missing." },
            { status: 500 }
        );
    }

    // Generate a random value to protect the OAuth flow from CSRF.
    const state = randomBytes(32).toString("hex");

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube",
        access_type: "offline",
        include_granted_scopes: "true",
        state,
        prompt: "consent",
    });

    const googleAuthorizationUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    const response = NextResponse.redirect(googleAuthorizationUrl);

    // Store state temporarily in an HttpOnly cookie.
    // response.cookies.set("youtube_oauth_state", state, {
    //     httpOnly: true,
    //     secure: process.env.NODE_ENV === "production",
    //     sameSite: "lax",
    //     path: "/",
    //     maxAge: 10 * 60, // 10 minutes
    // });

    response.cookies.set(
        "youtube_oauth_state",
        JSON.stringify({
            state,
            returnTo,
        }),
        {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 10 * 60,
        }
    );

    return response;
}