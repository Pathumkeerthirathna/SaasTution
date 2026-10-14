// Class Register: who of the class is present / absent in the live session.
// Plain JavaScript with JSDoc types so the same code runs in the app (the
// teacher's and the student's register) and in the Node test runner.
//
// A student counts as present when a meeting participant has their display
// name, or when they are in another room of this class (a breakout room).
// The same rule the teacher's register has always used.

/**
 * @template {{ displayName: string }} S
 * @param {S[] | null | undefined} students The class roster.
 * @param {{ displayName: string }[] | null | undefined} participants Live meeting participants.
 * @param {Record<string, string> | null | undefined} [breakoutRoomLabels]
 *   Display name -> room label, for people in a room other than this one.
 * @returns {{ present: S[], absent: S[], elsewhereLabel: (displayName: string) => string | undefined }}
 */
export function splitClassRegister(students, participants, breakoutRoomLabels) {
  const list = Array.isArray(students) ? students : [];
  const live = Array.isArray(participants) ? participants : [];
  const inThisRoom = new Set(live.map((participant) => participant.displayName));

  /** @param {string} displayName */
  const elsewhereLabel = (displayName) =>
    inThisRoom.has(displayName) ? undefined : breakoutRoomLabels?.[displayName] || undefined;

  /** @param {string} displayName */
  const isPresent = (displayName) => inThisRoom.has(displayName) || Boolean(elsewhereLabel(displayName));

  return {
    present: list.filter((student) => isPresent(student.displayName)),
    absent: list.filter((student) => !isPresent(student.displayName)),
    elsewhereLabel,
  };
}
