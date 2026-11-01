import { getYouTubeLiveBroadcast, type YouTubeLiveBroadcast } from "@/lib/youtube-live";
import { youtubeTimeouts } from "@/lib/youtube-request";

/*
 * Coordinated YouTube broadcast lookups for STATUS POLLING only: the
 * classroom live-status stream (one event fans out to every connected
 * student), the dashboards' "live now" cards and the teacher page's
 * recording check. Per server process, per broadcast:
 *
 * - One request at a time: concurrent callers share the request in flight.
 * - A non-terminal answer (ready, live, testing, ...) is reused for
 *   youtubeTimeouts.statusCacheMs (2 s): the status can be that much older,
 *   never more.
 * - A terminal answer (complete / revoked), "not found" and any failure are
 *   never kept: a caller that closes a row because the broadcast ended always
 *   acts on an answer obtained for its own call (or the one request it shared).
 *   A cached answer can therefore never confirm that a broadcast stopped.
 *
 * Lifecycle operations (Recording / Live starts and stops, the
 * teacher-departure stop, End Session and reconciliation) never use this:
 * they ask YouTube themselves, under the lecture lock. This takes no lock, so
 * polling never waits for or blocks them.
 */

type Entry = { at: number; answer: YouTubeLiveBroadcast };

const store = globalThis as unknown as {
  slYouTubeStatusCache?: { answers: Map<string, Entry>; inFlight: Map<string, Promise<YouTubeLiveBroadcast>> };
};

function cache() {
  store.slYouTubeStatusCache ??= { answers: new Map(), inFlight: new Map() };
  return store.slYouTubeStatusCache;
}

const TERMINAL = new Set(["complete", "revoked"]);

/** The broadcast's status for polling (see the header). Throws as getYouTubeLiveBroadcast does. */
export function getPolledYouTubeBroadcast(
  refreshTokenEncrypted: string,
  broadcastId: string
): Promise<YouTubeLiveBroadcast> {
  const { answers, inFlight } = cache();
  const kept = answers.get(broadcastId);

  if (kept && Date.now() - kept.at < youtubeTimeouts.statusCacheMs) {
    return Promise.resolve(kept.answer);
  }

  const pending = inFlight.get(broadcastId);

  if (pending) return pending;

  const request = getYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId)
    .then(answer => {
      const lifeCycleStatus = answer.status?.lifeCycleStatus;

      if (lifeCycleStatus && !TERMINAL.has(lifeCycleStatus)) {
        answers.set(broadcastId, { at: Date.now(), answer });
      } else {
        answers.delete(broadcastId);
      }

      return answer;
    }, error => {
      answers.delete(broadcastId);
      throw error;
    })
    .finally(() => {
      inFlight.delete(broadcastId);
    });

  inFlight.set(broadcastId, request);

  return request;
}

/** A lifecycle operation changed the broadcast (start, stop): the next poll asks YouTube. */
export function forgetPolledYouTubeBroadcast(broadcastId: string) {
  cache().answers.delete(broadcastId);
}

/** Tests: empty the cache. */
export function clearYouTubeStatusCache() {
  delete store.slYouTubeStatusCache;
}
