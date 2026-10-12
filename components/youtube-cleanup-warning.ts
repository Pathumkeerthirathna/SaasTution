import toast from "react-hot-toast";

import { getYoutubeSessionCleanupMessage } from "@/lib/youtube-error-messages";

/**
 * Shows the teacher a YouTube cleanup the server reported as still pending
 * (`youtubeCleanup` of End Session / session start). Nothing is shown when it
 * is done: only the server's answer decides.
 */
export function showYoutubeCleanupWarning(
  cleanup: { status?: string; reason?: string } | null | undefined,
  context: "end" | "start"
) {
  const message = getYoutubeSessionCleanupMessage(cleanup, context);

  if (message) {
    toast(message, { icon: "⚠️", duration: 10_000 });
  }
}
