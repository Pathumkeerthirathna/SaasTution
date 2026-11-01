import { backoffDelay, isParticipantId } from "./participant-identity.mjs";

/**
 * Teacher only: each class student's visits (join / leave) in the current
 * session, for the teacher view's tiles in the teacher's own Jitsi iframe
 * (SL_STUDENT_HISTORY). Read-only, from the existing records:
 *
 *  - GET /api/sessions/[id]/attendance  (teacher of the class only): every
 *    Attendance row of the session, per student, oldest first.
 *  - GET /api/sessions/[id]/events      (teacher of the class only): an
 *    "attendance-update" on every recorded join / leave. Some closes send no
 *    event (a join closing an older open visit, the session end), so every
 *    event refetches the whole history instead of patching it.
 *
 * Only times leave this module: never a contact, grade or name. Visits are
 * matched to tiles by studentId -> CURRENT participant ID (participant map),
 * never by display name.
 */

/** [joinedAtMs, leftAtMs | null]: one visit. */
export type Visit = [number, number | null];

/** studentId -> visits, oldest first. */
export type VisitHistory = Map<string, Visit[]>;

/** SL_STUDENT_HISTORY entry: [participantId, visits (latest, oldest first), total visits when more were cut]. */
export type StudentHistoryEntry = [string, Visit[]] | [string, Visit[], number];

/** Per message: students, and visits per student (the latest are kept; the total is sent). */
export const STUDENT_HISTORY_MAX_STUDENTS = 500;
export const STUDENT_HISTORY_MAX_VISITS = 50;

const time = (value: unknown): number | null => {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }

  const ms = new Date(value).getTime();

  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/**
 * The attendance endpoint's data -> studentId -> visits (oldest first). Only
 * the student ID and the two times are read; a malformed row is skipped.
 */
export function parseVisitHistory(data: unknown): VisitHistory {
  const history: VisitHistory = new Map();
  const joined = (data as { joinedStudents?: unknown } | null)?.joinedStudents;

  if (!Array.isArray(joined)) {
    return history;
  }

  for (const entry of joined) {
    const studentId = (entry as { student?: { id?: unknown } })?.student?.id;
    const logs = (entry as { logs?: unknown })?.logs;

    if (typeof studentId !== "string" || !studentId || !Array.isArray(logs)) {
      continue;
    }

    const visits: Visit[] = [];

    for (const log of logs) {
      const joinedAt = time((log as { joinedAt?: unknown })?.joinedAt);
      const rawLeft = (log as { leftAt?: unknown })?.leftAt;
      const leftAt = rawLeft === null || rawLeft === undefined ? null : time(rawLeft);

      if (joinedAt === null || (rawLeft !== null && rawLeft !== undefined && leftAt === null)) {
        continue;
      }

      visits.push([joinedAt, leftAt !== null && leftAt < joinedAt ? joinedAt : leftAt]);
    }

    if (visits.length) {
      visits.sort((a, b) => a[0] - b[0]);
      history.set(studentId, visits);
    }
  }

  return history;
}

/**
 * The SL_STUDENT_HISTORY entries: one per participant ID the teacher's map
 * currently gives to a class student with visits (participant ID -> studentId,
 * already limited to current, unambiguous entries and never the teacher's own
 * IDs). At most STUDENT_HISTORY_MAX_STUDENTS; a longer history keeps its latest
 * STUDENT_HISTORY_MAX_VISITS visits and says how many there are in all.
 */
export function studentHistoryEntries(
  studentByParticipantId: ReadonlyMap<string, string>,
  history: VisitHistory
): StudentHistoryEntry[] {
  const entries: StudentHistoryEntry[] = [];

  studentByParticipantId.forEach((studentId, participantId) => {
    const visits = history.get(studentId);

    if (!visits || !visits.length || !isParticipantId(participantId) || entries.length >= STUDENT_HISTORY_MAX_STUDENTS) {
      return;
    }

    entries.push(visits.length > STUDENT_HISTORY_MAX_VISITS
      ? [participantId, visits.slice(-STUDENT_HISTORY_MAX_VISITS), visits.length]
      : [participantId, visits.slice()]);
  });

  return entries;
}

/**
 * Keeps the visit history current: fetch now, then on every attendance
 * event (debounced), on every reconnect of the event stream, and on demand
 * (a new conference). One request at a time: events during a request ask for
 * one more fetch after it; an older response never replaces a newer one.
 */
export type VisitHistorySync = {
  start: () => void;
  /** Fetch again (debounced unless `now`). */
  refresh: (now?: boolean) => void;
  stop: () => void;
};

type SyncOptions = {
  /** Resolves with the endpoint's `data`, or rejects. */
  fetchHistory: (signal: AbortSignal) => Promise<unknown>;
  /** Opens the event stream; calls the handlers; returns a close function. */
  openEvents: (handlers: { onOpen: () => void; onUpdate: () => void; onError: () => void }) => () => void;
  onHistory: (history: VisitHistory) => void;
  debounceMs?: number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  createAbortController?: () => AbortController;
};

export function createVisitHistorySync({
  fetchHistory,
  openEvents,
  onHistory,
  debounceMs = 500,
  setTimeoutImpl = (callback, ms) => setTimeout(callback, ms),
  clearTimeoutImpl = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  createAbortController = () => new AbortController(),
}: SyncOptions): VisitHistorySync {
  let stopped = true;
  let debounceTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let closeEvents: (() => void) | null = null;
  let inFlight: AbortController | null = null;
  let again = false;
  let failures = 0;
  let connectedOnce = false;

  const fetchNow = () => {
    if (stopped) {
      return;
    }

    if (inFlight) {
      again = true;
      return;
    }

    const controller = createAbortController();

    inFlight = controller;
    again = false;

    fetchHistory(controller.signal).then(
      (data) => {
        if (inFlight === controller && !stopped) {
          onHistory(parseVisitHistory(data));
        }
      },
      () => {
        /* kept as it was; the next event or reconnect fetches again */
      }
    ).finally(() => {
      if (inFlight === controller) {
        inFlight = null;

        if (again && !stopped) {
          fetchNow();
        }
      }
    });
  };

  const refresh = (now = false) => {
    if (stopped) {
      return;
    }

    if (debounceTimer) {
      clearTimeoutImpl(debounceTimer);
      debounceTimer = null;
    }

    if (now) {
      fetchNow();
      return;
    }

    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      fetchNow();
    }, debounceMs);
  };

  const connect = () => {
    if (stopped) {
      return;
    }

    closeEvents = openEvents({
      onOpen: () => {
        failures = 0;

        // A reconnect: events may have been missed while it was down.
        if (connectedOnce) {
          refresh(true);
        }

        connectedOnce = true;
      },
      onUpdate: () => refresh(),
      onError: () => {
        closeEvents?.();
        closeEvents = null;

        if (stopped || reconnectTimer) {
          return;
        }

        reconnectTimer = setTimeoutImpl(() => {
          reconnectTimer = null;
          connect();
        }, backoffDelay(failures));
        failures += 1;
      },
    });
  };

  return {
    start: () => {
      if (!stopped) {
        return;
      }

      stopped = false;
      connectedOnce = false;
      failures = 0;
      fetchNow();
      connect();
    },
    refresh,
    stop: () => {
      stopped = true;

      if (debounceTimer) clearTimeoutImpl(debounceTimer);
      if (reconnectTimer) clearTimeoutImpl(reconnectTimer);

      debounceTimer = null;
      reconnectTimer = null;
      closeEvents?.();
      closeEvents = null;
      inFlight?.abort();
      inFlight = null;
      again = false;
    },
  };
}
