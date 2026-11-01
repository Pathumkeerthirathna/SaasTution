import { AsyncLocalStorage } from "node:async_hooks";

import { decryptYouTubeToken } from "@/lib/youtube-crypto";
import { youtubeFetch } from "@/lib/youtube-request";

export class YouTubeReauthorizationRequiredError extends Error {
    constructor() {
        super(
            "YouTube authorization has expired or been revoked."
        );

        this.name =
            "YouTubeReauthorizationRequiredError";
    }
}

/*
 * Access-token reuse, opt-in per operation (withYouTubeAccessTokenReuse):
 * inside it, every getYouTubeAccessToken for the same refresh token shares
 * ONE token request (parallel callers share the pending request). Never
 * stored beyond the operation, so an authorization revoked meanwhile is seen
 * by the next operation. A failed request is not kept: a later call in the
 * same operation asks Google again. Outside such an operation nothing changes.
 */
const tokenReuse = new AsyncLocalStorage<Map<string, Promise<string>>>();

export function withYouTubeAccessTokenReuse<T>(operation: () => Promise<T>): Promise<T> {
    return tokenReuse.getStore() ? operation() : tokenReuse.run(new Map(), operation);
}

export function getYouTubeAccessToken(
    encryptedRefreshToken: string
): Promise<string> {
    const reused = tokenReuse.getStore();

    if (!reused) {
        return requestYouTubeAccessToken(encryptedRefreshToken);
    }

    const pending = reused.get(encryptedRefreshToken);

    if (pending) {
        return pending;
    }

    const request = requestYouTubeAccessToken(encryptedRefreshToken);

    reused.set(encryptedRefreshToken, request);
    request.catch(() => {
        if (reused.get(encryptedRefreshToken) === request) {
            reused.delete(encryptedRefreshToken);
        }
    });

    return request;
}

async function requestYouTubeAccessToken(
    encryptedRefreshToken: string
): Promise<string> {

    const clientId =
        process.env.GOOGLE_YOUTUBE_CLIENT_ID;

    const clientSecret =
        process.env.GOOGLE_YOUTUBE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error(
            "Google YouTube OAuth configuration is missing."
        );
    }

    const refreshToken =
        decryptYouTubeToken(
            encryptedRefreshToken
        );

    const response = await youtubeFetch(
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
        const errorDetails =
            await response.text();

        console.error(
            "YouTube access token refresh failed:",
            errorDetails
        );

        if (
            errorDetails.includes(
                '"invalid_grant"'
            )
        ) {
            throw new YouTubeReauthorizationRequiredError();
        }

        throw new Error(
            "Unable to refresh YouTube access token."
        );
    }

    const tokenData =
        await response.json();

    if (!tokenData.access_token) {
        throw new Error(
            "Google did not return a YouTube access token."
        );
    }

    return tokenData.access_token;
}