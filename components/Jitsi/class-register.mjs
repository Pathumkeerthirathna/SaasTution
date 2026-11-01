// Class Register: who of the class is present / absent in the live session.
// Plain JavaScript with JSDoc types so the same code runs in the app (the
// teacher's and the student's register) and in the Node test runner.
//
// A student counts as present when their current mapped Jitsi participant ID
// is live in this room, or in another room of this class (a breakout room).
// Matching is by studentId -> participantId only (see participant-identity.mjs),
// never by display name.

/**
 * @template {{ studentId: string }} S
 * @param {S[] | null | undefined} students The class roster.
 * @param {Map<string, { participantId: string, roomLabel: string | null }> | null | undefined} locations
 *   studentId -> where that student is (resolveClassroomIdentity): roomLabel null = this room.
 * @returns {{
 *   present: S[],
 *   absent: S[],
 *   elsewhereLabel: (studentId: string) => string | undefined,
 *   participantIdOf: (studentId: string) => string | undefined,
 * }}
 */
export function splitClassRegister(students, locations) {
  const list = Array.isArray(students) ? students : [];

  /** @param {string} studentId */
  const isPresent = (studentId) => Boolean(locations?.has(studentId));

  return {
    present: list.filter((student) => isPresent(student.studentId)),
    absent: list.filter((student) => !isPresent(student.studentId)),
    elsewhereLabel: (studentId) => locations?.get(studentId)?.roomLabel || undefined,
    participantIdOf: (studentId) => locations?.get(studentId)?.participantId,
  };
}
