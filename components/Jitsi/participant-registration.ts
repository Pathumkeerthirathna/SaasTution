import { backoffDelay, shouldReregister } from "./participant-identity.mjs";

/**
 * Student -> participant ID registration (POST /api/sessions/[id]/participant-map).
 *
 * The server takes the student from the login session; only the participant
 * ID is sent. Safeguards:
 *  - Stale retries never overwrite a newer ID: before every attempt the ID
 *    must still be this browser's current participant ID.
 *  - A rejected ID (4xx: not enrolled, conflict, ended session) is not retried.
 *  - Failures (network, 5xx) retry with exponential backoff (5 s .. 60 s).
 *  - Self-repair: when the map the server sends does not show our current ID
 *    (server restart, lost registration), register again, unless the entry is
 *    an ID this browser never had (another tab or device owns the mapping).
 */

export type RegistrationResult = "ok" | "rejected" | "failed" | "stale";

export type ParticipantRegistration = {
  /** Register `participantId` now (every conference join). */
  start: (participantId: string) => void;
  /** Self-repair check against the latest map entry for this student. */
  ensure: (mappedParticipantId: string | undefined) => void;
  /** Cancels a scheduled retry (unmount). Safe to keep using afterwards (React strict mode remounts). */
  cancelRetry: () => void;
};

type Options = {
  getSessionId: () => string;
  getLocalParticipantId: () => string | null;
  getOwnParticipantIds: () => ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  /** Pause between the two immediate attempts of one registration. */
  retryPauseMs?: number;
  log?: (message: string, detail?: unknown) => void;
};

export function createParticipantRegistration({
  getSessionId,
  getLocalParticipantId,
  getOwnParticipantIds,
  fetchImpl = (...args) => fetch(...args),
  setTimeoutImpl = (callback, ms) => setTimeout(callback, ms),
  clearTimeoutImpl = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  retryPauseMs = 2000,
  log = (message, detail) => console.warn(message, detail),
}: Options): ParticipantRegistration {
  let inFlight: string | null = null;
  let retryTimer: unknown = null;
  let failures = 0;
  const rejected = new Set<string>();

  const isCurrent = (participantId: string) => getLocalParticipantId() === participantId;

  const post = async (participantId: string): Promise<RegistrationResult> => {
    const url = `/api/sessions/${getSessionId()}/participant-map`;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // A newer join (reconnect, breakout switch) registers its own ID; an
      // older one must never land after it.
      if (!isCurrent(participantId)) {
        return "stale";
      }

      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantId }),
        });

        if (response.ok) {
          return "ok";
        }

        // 4xx (not enrolled, conflict, ended session, bad ID) will not get better on retry.
        if (response.status < 500) {
          log("Participant ID registration rejected:", response.status);
          return "rejected";
        }
      } catch (error) {
        log("Participant ID registration failed:", error);
      }

      if (attempt === 1) {
        await new Promise<void>((resolve) => setTimeoutImpl(resolve, retryPauseMs));
      }
    }

    return "failed";
  };

  const start = (participantId: string) => {
    if (inFlight === participantId || rejected.has(participantId)) {
      return;
    }

    inFlight = participantId;

    void post(participantId).then((result) => {
      if (inFlight === participantId) {
        inFlight = null;
      }

      if (result === "ok") {
        failures = 0;
      } else if (result === "rejected") {
        rejected.add(participantId);
      } else if (result === "failed" && !retryTimer && isCurrent(participantId)) {
        const delay = backoffDelay(failures, { baseMs: 5000, maxMs: 60000 });

        failures += 1;
        retryTimer = setTimeoutImpl(() => {
          retryTimer = null;

          if (isCurrent(participantId)) {
            start(participantId);
          }
        }, delay);
      }
    });
  };

  const ensure = (mappedParticipantId: string | undefined) => {
    const localParticipantId = getLocalParticipantId();

    if (
      retryTimer ||
      !localParticipantId ||
      !shouldReregister({
        localParticipantId,
        mappedParticipantId,
        ownParticipantIds: getOwnParticipantIds(),
      })
    ) {
      return;
    }

    start(localParticipantId);
  };

  const cancelRetry = () => {
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
  };

  return { start, ensure, cancelRetry };
}
