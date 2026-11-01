// Classroom participant identity: which live Jitsi participant is which class
// student. Plain JavaScript with JSDoc types so the same code runs in the app
// and in the Node test runner.
//
// The identifiers, never interchangeable:
//  - studentId:     the application student (database), from the roster.
//  - participantId: the Jitsi participant ID (the MUC occupant nick, e.g.
//                   "d92a7329"). New on every conference join: first join,
//                   reconnect, breakout-room switch.
//  - participant map (server, lib/classroom-participant-map.ts):
//                   studentId -> the participantId that student registered
//                   most recently, from its authenticated login session.
//
// Display names are never used for identity: they are not unique and can be
// changed. A student is present only when their CURRENT mapped participant ID
// is live (in this room's participant list, or in a breakout room list), so a
// stale map entry (the map never forgets a student who left) is not presence.

/** Jitsi participant IDs are short hex strings (e.g. "de809448"); allow some headroom. */
export const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isParticipantId(value) {
  return typeof value === "string" && PARTICIPANT_ID_PATTERN.test(value);
}

/**
 * The Jitsi participant ID of a breakout rooms list entry, from its KEY.
 *
 * Jitsi's breakout rooms list (`breakoutRoomsUpdated` / `listBreakoutRooms()`,
 * built by Prosody's mod_muc_breakout_rooms) keys each participant by their
 * occupant JID, "<room>@<muc domain>/<participantId>": the resource is the MUC
 * nick, which is the participant ID (verified on staging, Jitsi 2.0.11248):
 *
 *   key: "0abad041-…@breakout.meet.slclassroom.live/d92a7329"  -> "d92a7329"
 *   jid: "d92a7329-ee44-…@meet.slclassroom.live/tw79LuAQTEIU"  (the REAL JID;
 *        its resource is the XMPP session, NOT the participant ID)
 *
 * The entry's `jid` is never read here; it stays for moving people
 * (`sendParticipantToRoom`). Returns null when the key is not of that form, so
 * a malformed entry is never matched to anyone.
 *
 * @param {unknown} key
 * @returns {string | null}
 */
export function participantIdFromRoomKey(key) {
  if (typeof key !== "string") {
    return null;
  }

  // XMPP: the resource starts at the FIRST "/" (any further "/" is part of it,
  // and then fails the participant ID pattern).
  const slash = key.indexOf("/");

  if (slash <= 0) {
    return null;
  }

  const bare = key.slice(0, slash);
  const resource = key.slice(slash + 1);

  if (!bare.includes("@")) {
    return null;
  }

  return isParticipantId(resource) ? resource : null;
}

/**
 * participantId -> studentId, from the current participant map. IDs of this
 * browser itself are never a student (a student cannot claim the teacher's ID
 * here), and an ID registered by two students is ambiguous, so it is no one.
 *
 * @param {Record<string, string> | null | undefined} participantMap studentId -> participantId
 * @param {Iterable<string>} [ownParticipantIds] This browser's own participant IDs.
 * @returns {Map<string, string>}
 */
export function studentIdByParticipantId(participantMap, ownParticipantIds) {
  const own = new Set(ownParticipantIds ?? []);
  /** @type {Map<string, string>} */
  const byParticipant = new Map();
  /** @type {Set<string>} */
  const ambiguous = new Set();

  for (const [studentId, participantId] of Object.entries(participantMap ?? {})) {
    if (!studentId || !isParticipantId(participantId) || own.has(participantId)) {
      continue;
    }

    if (byParticipant.has(participantId) && byParticipant.get(participantId) !== studentId) {
      ambiguous.add(participantId);
    }

    byParticipant.set(participantId, studentId);
  }

  ambiguous.forEach((participantId) => byParticipant.delete(participantId));

  return byParticipant;
}

/**
 * @typedef {{ participantId: string, roomLabel: string | null }} StudentLocation
 *   roomLabel null = in this browser's room; otherwise "Main room" or a breakout room name.
 */

/**
 * Where each class student is right now, and who in this room is not a class
 * student ("Other participants": the teacher's co-hosts, a student whose
 * registration has not arrived, an unregistered tab).
 *
 * @template {{ participantId: string }} P
 * @param {{
 *   students: { studentId: string }[] | null | undefined,
 *   participantMap: Record<string, string> | null | undefined,
 *   participants: P[] | null | undefined,
 *   roomLabelByParticipantId?: Record<string, string> | null,
 *   ownParticipantIds?: Iterable<string>,
 * }} input
 * @returns {{ locations: Map<string, StudentLocation>, others: P[] }}
 */
export function resolveClassroomIdentity({
  students,
  participantMap,
  participants,
  roomLabelByParticipantId,
  ownParticipantIds,
}) {
  const own = new Set(ownParticipantIds ?? []);
  const live = Array.isArray(participants) ? participants : [];
  const liveIds = new Set(live.map((participant) => participant.participantId));
  const byParticipant = studentIdByParticipantId(participantMap, own);
  const roster = Array.isArray(students) ? students : [];
  const rosterIds = new Set(roster.map((student) => student.studentId));

  /** @type {Map<string, StudentLocation>} */
  const locations = new Map();

  for (const { studentId } of roster) {
    const participantId = participantMap?.[studentId];

    // Only the current, unambiguous mapping counts.
    if (!isParticipantId(participantId) || byParticipant.get(participantId) !== studentId) {
      continue;
    }

    if (liveIds.has(participantId)) {
      locations.set(studentId, { participantId, roomLabel: null });
      continue;
    }

    const label = roomLabelByParticipantId?.[participantId];

    if (typeof label === "string" && label.length > 0) {
      locations.set(studentId, { participantId, roomLabel: label });
    }
  }

  // Until the roster is known nobody can be told apart, so nobody is "other".
  const others = Array.isArray(students)
    ? live.filter((participant) => {
        if (own.has(participant.participantId)) {
          return false;
        }

        const studentId = byParticipant.get(participant.participantId);

        return !studentId || !rosterIds.has(studentId);
      })
    : [];

  return { locations, others };
}

/**
 * The live participant (mic / camera state, mute target) of a class student,
 * by the student's mapped participant ID. Undefined when the student is not
 * live in this room (absent, or in another room).
 *
 * @template {{ participantId: string }} P
 * @param {string} studentId
 * @param {Map<string, StudentLocation> | null | undefined} locations
 * @param {P[] | null | undefined} participants
 * @returns {P | undefined}
 */
export function liveParticipantForStudent(studentId, locations, participants) {
  const location = locations?.get(studentId);

  if (!location || location.roomLabel !== null || !Array.isArray(participants)) {
    return undefined;
  }

  return participants.find((participant) => participant.participantId === location.participantId);
}

/**
 * Attendance panel: is this student in the session, and where.
 *
 * @param {string} studentId
 * @param {Map<string, StudentLocation> | null | undefined} locations
 * @returns {{ inSession: boolean, roomLabel: string | null }}
 */
export function sessionStatusFor(studentId, locations) {
  const location = locations?.get(studentId);

  return { inSession: Boolean(location), roomLabel: location?.roomLabel ?? null };
}

/**
 * Display-only grace: a student who just vanished (reconnect, breakout-room
 * switch: their new participant ID is not registered yet) keeps their last
 * location for `graceMs`, so the registers do not flicker to "absent". Never
 * used for actions: a grace location's participant ID is not live, so it has
 * no mute target or mic / camera state.
 *
 * @param {Map<string, { location: StudentLocation, lastSeenAt: number }>} memory Previous result's memory.
 * @param {Map<string, StudentLocation>} current
 * @param {number} now
 * @param {number} graceMs
 * @returns {{
 *   display: Map<string, StudentLocation>,
 *   memory: Map<string, { location: StudentLocation, lastSeenAt: number }>,
 *   nextExpiryAt: number | null,
 * }}
 */
export function applyPresenceGrace(memory, current, now, graceMs) {
  /** @type {Map<string, StudentLocation>} */
  const display = new Map(current);
  /** @type {Map<string, { location: StudentLocation, lastSeenAt: number }>} */
  const nextMemory = new Map();
  /** @type {number | null} */
  let nextExpiryAt = null;

  current.forEach((location, studentId) => {
    nextMemory.set(studentId, { location, lastSeenAt: now });
  });

  memory.forEach((entry, studentId) => {
    if (current.has(studentId)) {
      return;
    }

    const expiresAt = entry.lastSeenAt + graceMs;

    if (expiresAt > now) {
      display.set(studentId, entry.location);
      nextMemory.set(studentId, entry);
      nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
    }
  });

  return { display, memory: nextMemory, nextExpiryAt };
}

/**
 * Student self-repair: should this browser (re)register its participant ID,
 * given the map the server just sent?
 *
 *  - The map shows our current ID: nothing to do.
 *  - No entry for us, or an entry that is one of OUR earlier IDs (the server
 *    restarted, a registration was lost, or a stale retry won): register.
 *  - An entry that is an ID this browser never had: another tab / device of
 *    the same student joined later and owns the mapping. Do not fight it.
 *
 * @param {{
 *   localParticipantId: string | null | undefined,
 *   mappedParticipantId: string | null | undefined,
 *   ownParticipantIds: Iterable<string>,
 * }} input
 * @returns {boolean}
 */
export function shouldReregister({ localParticipantId, mappedParticipantId, ownParticipantIds }) {
  if (!isParticipantId(localParticipantId)) {
    return false;
  }

  if (mappedParticipantId === localParticipantId) {
    return false;
  }

  if (!mappedParticipantId) {
    return true;
  }

  return new Set(ownParticipantIds).has(mappedParticipantId);
}

/**
 * Exponential backoff with jitter: 1 s, 2 s, 4 s ... capped.
 *
 * @param {number} attempt 0-based
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 * @returns {number}
 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 30000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));

  // Up to 20 % jitter so many browsers do not reconnect in lockstep.
  return Math.round(exponential * (0.8 + 0.2 * random()));
}

// ---- Display names (presentation only) -----------------------------------------
//
// A participant's current Jitsi display name is shown next to who they are, but it
// never decides who they are: names are attached to participant IDs, and a class
// student is still found by studentId -> participantId (participant map) only.

/** Longest display name kept (Jitsi has no limit of its own). */
export const DISPLAY_NAME_MAX_LENGTH = 100;

// C0 / C1 control characters and the bidirectional overrides / isolates, which
// could make one name render as another.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * A display name made safe to store and show: control and bidi-override
 * characters removed, whitespace collapsed and trimmed, cut to
 * {@link DISPLAY_NAME_MAX_LENGTH} characters. "" for an empty name; null when
 * `value` is not a string.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    return null;
  }

  // Whitespace (tabs and newlines are control characters too) becomes a space
  // first, so words never run together; then the rest are removed.
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(UNSAFE_NAME_CHARACTERS, "")
    .replace(/ {2,}/g, " ")
    .trim();

  return Array.from(cleaned).slice(0, DISPLAY_NAME_MAX_LENGTH).join("").trim();
}

/**
 * Teacher's label for a class student: "<Jitsi name> (<registered name>)" when
 * the student's current Jitsi name differs from their registered name, else the
 * registered name alone.
 *
 * @param {string} registeredName
 * @param {unknown} jitsiName
 * @returns {string}
 */
export function studentDisplayLabel(registeredName, jitsiName) {
  const live = normalizeDisplayName(jitsiName);

  if (!live || live === normalizeDisplayName(registeredName)) {
    return registeredName;
  }

  return `${live} (${registeredName})`;
}

/**
 * Participant ID -> current Jitsi display name, from every source the browser
 * has, freshest last (a later source replaces an earlier one):
 *
 *  1. `roomEntries`: Jitsi's breakout rooms list. Covers every room, but only
 *     refreshed when someone joins or leaves a room, not on a rename.
 *  2. `reportedNames` (studentId -> name, participant map): each student's own
 *     report of its current name, attached to that student's CURRENT mapped
 *     participant ID only. Covers renames in rooms this browser is not in.
 *  3. `participants`: this browser's own conference, live (refreshed on every
 *     rename). Always wins, including an empty name.
 *
 * Names never identify anyone; the result is keyed by participant ID.
 *
 * @param {{
 *   roomEntries?: Iterable<{ participantId: string | null, displayName: string }>,
 *   participantMap?: Record<string, string> | null,
 *   reportedNames?: Record<string, string> | null,
 *   participants?: Iterable<{ participantId: string, displayName?: string }>,
 * }} sources
 * @returns {Map<string, string>}
 */
export function displayNameByParticipantId({ roomEntries, participantMap, reportedNames, participants }) {
  /** @type {Map<string, string>} */
  const names = new Map();

  for (const entry of roomEntries ?? []) {
    const name = normalizeDisplayName(entry.displayName);

    if (isParticipantId(entry.participantId) && name) {
      names.set(entry.participantId, name);
    }
  }

  for (const [studentId, reported] of Object.entries(reportedNames ?? {})) {
    const participantId = participantMap?.[studentId];
    const name = normalizeDisplayName(reported);

    if (isParticipantId(participantId) && name) {
      names.set(participantId, name);
    }
  }

  for (const participant of participants ?? []) {
    if (isParticipantId(participant.participantId)) {
      names.set(participant.participantId, normalizeDisplayName(participant.displayName) ?? "");
    }
  }

  return names;
}

/**
 * Checks a display name a person typed for themselves (presentation only):
 * the cleaned name, or why it cannot be used. Never cut silently: a name
 * longer than {@link DISPLAY_NAME_MAX_LENGTH} characters is refused.
 *
 * @param {unknown} value
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateDisplayName(value) {
  if (typeof value !== "string") {
    return { ok: false, error: "Enter a display name." };
  }

  const name = normalizeDisplayName(value) ?? "";
  const typed = Array.from(value.replace(/\s+/g, " ").trim()).length;

  if (!name) {
    return { ok: false, error: "Enter a display name." };
  }

  if (typed > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, error: `Use at most ${DISPLAY_NAME_MAX_LENGTH} characters.` };
  }

  return { ok: true, name };
}
