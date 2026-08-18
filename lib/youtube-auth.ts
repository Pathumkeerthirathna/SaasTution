import { decryptYouTubeToken } from "@/lib/youtube-crypto";

export async function getYouTubeAccessToken(
    encryptedRefreshToken: string
): Promise<string> {
    const clientId = process.env.GOOGLE_YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_YOUTUBE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error(
            "Google YouTube OAuth configuration is missing."
        );
    }

    const refreshToken =
        decryptYouTubeToken(encryptedRefreshToken);

    const response = await fetch(
        "https://oauth2.googleapis.com/token",
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }),
        }
    );

    if (!response.ok) {
        const errorDetails = await response.text();

        console.error(
            "YouTube access token refresh failed:",
            errorDetails
        );

        throw new Error(
            "Unable to refresh YouTube access token."
        );
    }

    const tokenData = await response.json();

    if (!tokenData.access_token) {
        throw new Error(
            "Google did not return a YouTube access token."
        );
    }

    return tokenData.access_token;
}