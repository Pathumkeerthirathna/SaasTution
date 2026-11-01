import { backoffDelay, normalizeDisplayName, validateDisplayName } from "./participant-identity.mjs";

/**
 * Student -> its current Jitsi display name (PATCH /api/sessions/[id]/participant-map),
 * so the teacher sees a rename even in a room the teacher is not in. Display only:
 * the name is attached to the student's current participant ID and never used for
 * identity. Registration (participant-registration.ts) is unchanged and separate.
 *
 * Reconciles instead of firing per event: whenever the map the server sends, or the
 * local name, changes, it compares the server's name for this student with the local
 * one, and reports only when they differ for the CURRENT participant ID. So a
 * reconnect (new ID, name cleared on the server), a server restart or a missed
 * event is repaired by the next map update. Safeguards:
 *  - Never reports for an ID that is not both the local and the mapped one.
 *  - One request at a time; a newer name is sent after it, not in parallel.
 *  - A refused report (4xx, or "not current") is not repeated until the map changes.
 *  - Failures (network, 5xx) retry with exponential backoff (5 s .. 60 s).
 */

export type DisplayNameReporter = {
  /** The latest map entry for this student (participant ID and reported name). */
  sync: (mappedParticipantId: string | undefined, mappedDisplayName: string | undefined) => void;
  /** The local display name may have changed (Jitsi `displayNameChange`). */
  nameChanged: () => void;
  /** Cancels a scheduled retry (unmount). Safe to keep using afterwards. */
  cancelRetry: () => void;
};

type Options = {
  getSessionId: () => string;
  getLocalParticipantId: () => string | null;
  getLocalDisplayName: () => string | null;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  log?: (message: string, detail?: unknown) => void;
};

export function createDisplayNameReporter({
  getSessionId,
  getLocalParticipantId,
  getLocalDisplayName,
  fetchImpl = (...args) => fetch(...args),
  setTimeoutImpl = (callback, ms) => setTimeout(callback, ms),
  clearTimeoutImpl = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  log = (message, detail) => console.warn(message, detail),
}: Options): DisplayNameReporter {
  let mapped: { participantId?: string; displayName: string } = { displayName: "" };
  let inFlight = false;
  let retryTimer: unknown = null;
  let failures = 0;
  // A report the server refused; not repeated until the map changes.
  let refusedKey: string | null = null;

  const cancelRetry = () => {
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
  };

  const wanted = () => {
    const participantId = getLocalParticipantId();
    const displayName = normalizeDisplayName(getLocalDisplayName()) ?? "";

    if (!participantId || mapped.participantId !== participantId || mapped.displayName === displayName) {
      return null;
    }

    return { participantId, displayName, key: `${participantId}\n${displayName}` };
  };

  const run = () => {
    const target = wanted();

    if (!target) {
      cancelRetry();
      failures = 0;
      return;
    }

    if (inFlight || target.key === refusedKey) {
      return;
    }

    cancelRetry();
    inFlight = true;

    void (async () => {
      let outcome: "ok" | "refused" | "failed" = "failed";

      try {
        const response = await fetchImpl(`/api/sessions/${getSessionId()}/participant-map`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantId: target.participantId, displayName: target.displayName }),
        });

        if (response.ok) {
          const body = (await response.json().catch(() => null)) as { data?: { updated?: unknown } } | null;

          outcome = body?.data?.updated === false ? "refused" : "ok";
        } else if (response.status < 500) {
          log("Display name report rejected:", response.status);
          outcome = "refused";
        }
      } catch (error) {
        log("Display name report failed:", error);
      }

      inFlight = false;

      if (outcome === "ok") {
        failures = 0;

        // The server now has it (its map update follows); a newer local name goes next.
        if (mapped.participantId === target.participantId) {
          mapped = { ...mapped, displayName: target.displayName };
        }

        run();
      } else if (outcome === "refused") {
        refusedKey = target.key;
      } else if (!retryTimer) {
        const delay = backoffDelay(failures, { baseMs: 5000, maxMs: 60000 });

        failures += 1;
        retryTimer = setTimeoutImpl(() => {
          retryTimer = null;
          run();
        }, delay);
      }
    })();
  };

  return {
    sync: (mappedParticipantId, mappedDisplayName) => {
      mapped = { participantId: mappedParticipantId, displayName: normalizeDisplayName(mappedDisplayName) ?? "" };
      refusedKey = null;
      run();
    },
    nameChanged: run,
    cancelRetry,
  };
}

/**
 * Student -> changes its OWN Jitsi display name with Jitsi's own command
 * (`executeCommand("displayName", name)`, the action Jitsi's profile settings
 * dispatch), and waits for Jitsi to confirm it with `displayNameChange` for
 * the local participant. One change at a time; the name the page shows only
 * ever comes from Jitsi's confirmation. The registered name is never involved.
 */
export type DisplayNameChanger = {
  /** Resolves with the confirmed name; rejects with a message for the person. */
  change: (name: string) => Promise<string>;
  /** Jitsi confirmed a local display name (call from `displayNameChange`). */
  confirmed: (name: string) => void;
  /** Rejects a pending change (unmount). */
  cancel: (message: string) => void;
};

type ChangerOptions = {
  getApi: () => { executeCommand: (command: string, ...args: unknown[]) => void } | null;
  getCurrentName: () => string | null;
  timeoutMs: number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
};

export function createDisplayNameChanger({
  getApi,
  getCurrentName,
  timeoutMs,
  setTimeoutImpl = (callback, ms) => setTimeout(callback, ms),
  clearTimeoutImpl = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: ChangerOptions): DisplayNameChanger {
  let pending: { resolve: (name: string) => void; reject: (error: Error) => void } | null = null;

  return {
    change: (name) => {
      const checked = validateDisplayName(name);

      if (!checked.ok) {
        return Promise.reject(new Error(checked.error));
      }

      const api = getApi();

      if (!api) {
        return Promise.reject(new Error("The classroom is not connected yet."));
      }

      if (pending) {
        return Promise.reject(new Error("A name change is already in progress."));
      }

      // Already this name: Jitsi would send no change event.
      if (checked.name === normalizeDisplayName(getCurrentName())) {
        return Promise.resolve(checked.name);
      }

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeoutImpl(() => {
          settle.reject(new Error("Jitsi did not confirm the new name. Please try again."));
        }, timeoutMs);

        const settle = {
          resolve: (confirmedName: string) => {
            clearTimeoutImpl(timer);
            pending = null;
            resolve(confirmedName);
          },
          reject: (error: Error) => {
            clearTimeoutImpl(timer);
            pending = null;
            reject(error);
          },
        };

        pending = settle;

        try {
          api.executeCommand("displayName", checked.name);
        } catch {
          settle.reject(new Error("Jitsi could not change the name. Please try again."));
        }
      });
    },
    confirmed: (name) => pending?.resolve(name),
    cancel: (message) => pending?.reject(new Error(message)),
  };
}
