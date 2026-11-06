// The teacher's proposed Group Activities members, from what the classroom
// page already has (read only; the existing breakout-room features are not
// touched):
//   - the existing breakout rooms and their occupants (useBreakoutRooms:
//     breakout.breakoutRooms, each occupant with its Jitsi participant ID);
//   - studentId -> participantId of the class students the page can place
//     (studentLocations, from the existing participant map);
//   - the class students' registered names (ClassroomStudents).
// It is only a PROPOSAL: the teacher reviews it and confirms it, and the
// server checks every student against the class enrolment. Occupants that
// are not a known class student (the teacher, a guest, a student whose
// registration has not arrived) are counted, never guessed.

import type { BreakoutRoom, ClassroomStudent } from "../../../types";

export type ProposedRoom = {
  id: string;
  name: string;
  students: { studentId: string; name: string }[];
  /** Occupants who are not a known class student. */
  otherOccupants: number;
};

export function roomDisplayName(room: { name: string }, index: number): string {
  const name = room.name.trim();
  return name !== "" ? name : `Breakout room ${index + 1}`;
}

export function proposeRooms(
  rooms: readonly BreakoutRoom[] | undefined,
  studentLocations: ReadonlyMap<string, { participantId: string }> | undefined,
  students: readonly ClassroomStudent[] | undefined
): ProposedRoom[] {
  const studentByParticipant = new Map<string, string>();
  studentLocations?.forEach((location, studentId) => {
    if (location?.participantId) studentByParticipant.set(location.participantId, studentId);
  });
  const nameOf = new Map((students ?? []).map((s) => [s.studentId, s.displayName]));
  const placed = new Set<string>();

  return (rooms ?? [])
    .filter((room) => !room.isMainRoom)
    .map((room, index) => {
      const proposed: ProposedRoom = { id: room.id, name: roomDisplayName(room, index), students: [], otherOccupants: 0 };
      for (const occupant of room.participants) {
        const studentId = occupant.participantId ? studentByParticipant.get(occupant.participantId) : undefined;
        if (!studentId || !nameOf.has(studentId)) {
          proposed.otherOccupants += 1;
          continue;
        }
        if (placed.has(studentId)) continue; // a stale second entry: the first room wins
        placed.add(studentId);
        proposed.students.push({ studentId, name: nameOf.get(studentId) ?? "Student" });
      }
      proposed.students.sort((a, b) => a.name.localeCompare(b.name));
      return proposed;
    });
}
