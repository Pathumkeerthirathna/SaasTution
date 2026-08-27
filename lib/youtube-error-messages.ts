/**
 * Maps technical YouTube/recording/live error messages (thrown by the
 * backend or the fetch layer) to short, human-readable text safe to show
 * directly to a teacher in a toast notification.
 */

type YouTubeAction = "recording" | "live";

export function getYoutubeFriendlyErrorMessage(
    rawMessage: string | null | undefined,
    action: YouTubeAction,
    code?: string | null
): string {
    const actionLabel =
        action === "recording"
            ? "recording"
            : "live stream";

    if (code === "YOUTUBE_REAUTH_REQUIRED") {
        return "Your YouTube connection has expired. Please reconnect your YouTube account and try again.";
    }

    if (code === "YOUTUBE_NOT_CONNECTED") {
        return "Connect your YouTube channel before starting a " + actionLabel + ".";
    }

    const message = (rawMessage ?? "").toLowerCase();

    if (!message) {
        return `Unable to start the ${actionLabel}. Please try again.`;
    }

    if (
        message.includes("connection pool timeout") ||
        message.includes("timed out fetching a new connection") ||
        message.includes("failed to fetch") ||
        message.includes("network")
    ) {
        return "Connection problem. Please check your internet connection and try again.";
    }

    if (
        message.includes("reauth") ||
        message.includes("renewed") ||
        message.includes("access token") ||
        message.includes("refresh")
    ) {
        return "Your YouTube connection has expired. Please reconnect your YouTube account and try again.";
    }

    if (
        message.includes("not connected a youtube channel") ||
        message.includes("not connected")
    ) {
        return "Connect your YouTube channel before starting a " + actionLabel + ".";
    }

    if (message.includes("not authorized")) {
        return `You don't have permission to start this ${actionLabel}.`;
    }

    if (message.includes("lecture not found")) {
        return "This lecture could not be found. Please refresh the page and try again.";
    }

    if (message.includes("quota")) {
        return "YouTube's daily limit has been reached. Please try again later.";
    }

    if (
        message.includes("live stream") ||
        message.includes("broadcast") ||
        message.includes("stream key")
    ) {
        return `YouTube couldn't be set up right now. Please try again in a moment.`;
    }

    return `Something went wrong while starting the ${actionLabel}. Please try again.`;
}
