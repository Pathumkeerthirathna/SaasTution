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

    // Deliberate refusals from the broadcast checks: say why, not "failed".
    if (code === "YOUTUBE_SHARED_BROADCAST_PRIVACY") {
        return "This live stream shares its YouTube video with the class recording, so it stays Unlisted. Stop Live, then start it again to choose another privacy.";
    }

    if (code === "YOUTUBE_BROADCAST_BUSY") {
        return "YouTube is still starting the current broadcast. Please try again in a few seconds.";
    }

    if (code === "YOUTUBE_BROADCAST_CHECK_FAILED") {
        return `Couldn't check the current YouTube broadcast, so the ${actionLabel} was not started. Please try again in a moment.`;
    }

    if (code === "YOUTUBE_OPERATION_IN_PROGRESS") {
        return "Another recording or live action is still in progress for this lecture. Please try again in a moment.";
    }

    if (code === "YOUTUBE_STREAM_IN_USE") {
        return `Your YouTube stream is already being used by a recording or live stream in another class. Stop it there before starting a ${actionLabel} here.`;
    }

    if (code === "YOUTUBE_CONNECTION_CHANGED") {
        return `Your YouTube connection changed while the ${actionLabel} was being prepared. Please try again.`;
    }

    if (code === "CLASS_SESSION_NOT_ACTIVE") {
        return `This class session is no longer active. Start or rejoin the current class session before starting a ${actionLabel}.`;
    }

    if (code === "YOUTUBE_RECONCILIATION_PENDING") {
        return `A recording or live stream from an earlier class session could not be ended on YouTube yet, so the ${actionLabel} was not started. Please try again in a moment.`;
    }

    if (code === "YOUTUBE_TIMEOUT") {
        return `YouTube did not answer in time, so the ${actionLabel} was not started. Please try again in a moment.`;
    }

    // The page's own Jibri confirmation (components/Jitsi/youtube-stream-controller.ts).
    if (code === "JIBRI_START_TIMEOUT") {
        return `The ${actionLabel} did not start: the classroom stream was not confirmed in time. Nothing was left running. Please try again.`;
    }

    if (code === "JIBRI_START_FAILED") {
        return `The ${actionLabel} did not start: the classroom stream reported an error. Nothing was left running. Please try again.`;
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

/** Teacher-facing text for a Stop Recording / Stop Live that did not go through. */
export function getYoutubeStopErrorMessage(
    action: YouTubeAction,
    code?: string | null
): string {
    const actionLabel =
        action === "recording"
            ? "recording"
            : "live stream";

    switch (code) {
        case "YOUTUBE_REAUTH_REQUIRED":
            return "Your YouTube connection has expired. Please reconnect your YouTube account, then stop the " + actionLabel + " again.";
        case "YOUTUBE_OPERATION_IN_PROGRESS":
            return "Another recording or live action is still in progress for this lecture. Please try again in a moment.";
        case "YOUTUBE_BROADCAST_CHECK_FAILED":
        case "YOUTUBE_BROADCAST_STOP_FAILED":
            return `Couldn't reach YouTube, so the ${actionLabel} is still running. Please try stopping it again in a moment.`;
        case "YOUTUBE_TIMEOUT":
            return `YouTube did not answer in time, so the ${actionLabel} may still be running. Please try stopping it again in a moment.`;
        default:
            return `The ${actionLabel} could not be stopped. Please try again.`;
    }
}

/** When the classroom's YouTube stream stops without the teacher stopping it. */
export function getYoutubeStreamStoppedMessage(features: YouTubeAction[]): string {
    const what =
        features.length > 1
            ? "Recording and Live have"
            : features[0] === "recording"
                ? "Recording has"
                : "Live has";

    return `The classroom's YouTube stream stopped unexpectedly. ${what} ended — start again to resume.`;
}

/**
 * The YouTube cleanup that ran with a class session ending (`context: "end"`)
 * or starting (`"start"`, leftovers of earlier sessions), as the server
 * reported it (`youtubeCleanup`). Text only when it is still pending: the
 * server did not confirm it, so the teacher is told; nothing is claimed done.
 */
export function getYoutubeSessionCleanupMessage(
    cleanup: { status?: string; reason?: string } | null | undefined,
    context: "end" | "start"
): string | null {
    if (cleanup?.status !== "pending") {
        return null;
    }

    if (cleanup.reason === "reauth-required") {
        return context === "end"
            ? "The class session ended, but your YouTube connection has expired, so its recording or live stream could not be closed on YouTube. Reconnect YouTube; it will then be closed when this lecture's next session starts."
            : "Your YouTube connection has expired, so a recording or live stream left from an earlier session could not be closed on YouTube. Reconnect YouTube before starting Recording or Live.";
    }

    return context === "end"
        ? "The class session ended, but YouTube did not confirm that its recording or live stream was closed. It will be retried when this lecture's next class session starts."
        : "YouTube did not confirm that a recording or live stream left from an earlier session was closed. Recording and Live may be refused until it is; please try again in a moment.";
}

/** A failed start whose server-side cleanup could not be confirmed. */
export function getYoutubeCleanupPendingMessage(action: YouTubeAction): string {
    const label = action === "recording" ? "recording" : "live stream";

    return `The ${label} did not start, and its cleanup could not be confirmed. It is shown as active so you can press Stop to finish it.`;
}
