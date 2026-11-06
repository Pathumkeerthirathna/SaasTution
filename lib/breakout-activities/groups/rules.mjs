// Group Activities: pure rules (no database, no I/O), shared by the services
// and the tests.

import { isUnanswered } from "../marking.mjs";
//
// A "group" is the students the teacher CONFIRMED for one breakout room of a
// session (BreakoutRoomMember, status 0). The teacher confirms a list of
// rooms, each with its student ids; planMembershipUpdate() turns that list
// and the current active memberships into the exact writes, so that after
// them every listed room has exactly the confirmed students, a student is in
// at most one room (moving a student removes their old membership first),
// and rooms that were not listed stay as they are.

/**
 * @typedef {{ id: string, roomId: string, roomName: string, studentId: string }} ActiveMembership
 * @typedef {{ id: string, name: string, studentIds: string[] }} ConfirmedRoom
 */

/**
 * The writes for a membership update.
 *
 * @param {ActiveMembership[]} active every ACTIVE membership of the session
 * @param {ConfirmedRoom[]} rooms the confirmed rooms (validated: unique room
 *   ids, no student in two rooms)
 * @returns {{
 *   remove: string[],                                  // membership ids -> status 1
 *   rename: { id: string, roomName: string }[],        // kept rows whose room name changed
 *   add: { roomId: string, roomName: string, studentId: string }[],
 *   affectedStudentIds: string[],                      // everyone added, removed or kept in a listed room
 * }}
 */
export function planMembershipUpdate(active, rooms) {
  const confirmedRoomOf = new Map();
  for (const room of rooms) for (const studentId of room.studentIds) confirmedRoomOf.set(studentId, room);
  const listedRoomIds = new Set(rooms.map((room) => room.id));

  const remove = [];
  const rename = [];
  const kept = new Set(); // studentIds whose active row stays
  const affected = new Set();

  for (const row of active) {
    const target = confirmedRoomOf.get(row.studentId);
    if (target && target.id === row.roomId) {
      kept.add(row.studentId);
      affected.add(row.studentId);
      if (row.roomName !== target.name) rename.push({ id: row.id, roomName: target.name });
      continue;
    }
    // Listed elsewhere (moved), or no longer listed in a room that WAS listed: removed.
    if (target || listedRoomIds.has(row.roomId)) {
      remove.push(row.id);
      affected.add(row.studentId);
    }
  }

  const add = [];
  for (const room of rooms) {
    for (const studentId of room.studentIds) {
      if (kept.has(studentId)) continue;
      add.push({ roomId: room.id, roomName: room.name, studentId });
      affected.add(studentId);
    }
  }

  return { remove, rename, add, affectedStudentIds: [...affected].sort() };
}

/**
 * Student ids of a room's active members, sorted (the membership snapshot
 * stored with a final group submission).
 *
 * @param {{ roomId: string, studentId: string }[]} active
 * @param {string} roomId
 * @returns {string[]}
 */
export function memberSnapshot(active, roomId) {
  return [...new Set(active.filter((row) => row.roomId === roomId).map((row) => row.studentId))].sort();
}

/**
 * How many of a quiz's questions have an answer (progress), by the same
 * rule the marking uses (marking.mjs isUnanswered: no answer, a cleared one,
 * or an answer of the wrong kind does not count).
 *
 * @param {unknown} answers stored answers (questionId -> { kind, ... })
 * @param {import("../marking.mjs").QuizQuestion[]} questions
 * @returns {number}
 */
export function answeredCount(answers, questions) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return 0;
  const byId = /** @type {Record<string, unknown>} */ (answers);
  let count = 0;
  for (const question of questions) {
    const answer = Object.prototype.hasOwnProperty.call(byId, question.id) ? byId[question.id] : undefined;
    if (!isUnanswered(question, /** @type {never} */ (answer))) count += 1;
  }
  return count;
}

/**
 * The difference between the confirmed members of each room and the class
 * students the teacher's page currently sees in that room (display only:
 * the teacher decides whether to update). Rooms are matched by id.
 *
 * @param {{ roomId: string, studentId: string }[]} confirmed active memberships
 * @param {{ roomId: string, studentIds: string[] }[]} current rooms as the teacher's page sees them now
 * @returns {{ roomId: string, joined: string[], left: string[] }[]} only rooms with a difference
 */
export function membershipDiff(confirmed, current) {
  const roomIds = new Set([...confirmed.map((row) => row.roomId), ...current.map((room) => room.roomId)]);
  const out = [];
  for (const roomId of [...roomIds].sort()) {
    const was = new Set(confirmed.filter((row) => row.roomId === roomId).map((row) => row.studentId));
    const now = new Set(current.find((room) => room.roomId === roomId)?.studentIds ?? []);
    const joined = [...now].filter((id) => !was.has(id)).sort();
    const left = [...was].filter((id) => !now.has(id)).sort();
    if (joined.length || left.length) out.push({ roomId, joined, left });
  }
  return out;
}
