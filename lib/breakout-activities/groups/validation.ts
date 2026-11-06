// Group Activities request validation (zod), built on the existing breakout
// schemas so every shared rule (room id format, title / instructions limits,
// quiz definition, answers, grading overrides) stays exactly the same.
//
// Rooms come from the teacher's own classroom page (the existing breakout
// rooms it lists) and are confirmed by the teacher: { id, name, studentIds }.
// Checked here: the room id with the existing BREAKOUT target rule, the name
// with the existing room-name normalization, student ids as UUIDs, no room
// twice, no student twice (in one room or across rooms). Whether each
// student is actively enrolled in the session's class is checked by the
// service, against the database.

import { z } from "zod";

import { normalizeRoomName } from "../target-rooms";
import { assignmentCreateSchema, quizCreateSchema, targetSchema } from "../validation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GROUP_LIMITS = { roomsMax: 50, studentsPerRoomMax: 200 } as const;

const studentIdSchema = z.string().regex(UUID, "Invalid student id.").transform((id) => id.toLowerCase());

const roomIdSchema = z.string().refine((id) => targetSchema.safeParse({ type: "BREAKOUT", id }).success, "Invalid room id.");

const roomNameSchema = z
  .string()
  .transform((name) => normalizeRoomName(name))
  .refine((name): name is string => name !== null, "Every room needs a name.")
  .transform((name) => name as string);

export const confirmedRoomSchema = z.strictObject({
  id: roomIdSchema,
  name: roomNameSchema,
  studentIds: z.array(studentIdSchema).max(GROUP_LIMITS.studentsPerRoomMax),
});

export const confirmedRoomsSchema = z
  .array(confirmedRoomSchema)
  .min(1, "Choose at least one breakout room.")
  .max(GROUP_LIMITS.roomsMax)
  .refine((rooms) => new Set(rooms.map((room) => room.id)).size === rooms.length, "A room is chosen twice.")
  .refine((rooms) => {
    const all = rooms.flatMap((room) => room.studentIds);
    return new Set(all).size === all.length;
  }, "A student can be in only one group.");

export type ConfirmedRoom = z.output<typeof confirmedRoomSchema>;

/** PUT …/groups/members: update the confirmed members of the listed rooms. */
export const membersUpdateSchema = z.strictObject({ rooms: confirmedRoomsSchema });

/** Multipart fields of POST …/groups/assignments (the brief PDF is checked by pdf-file.ts). */
export const groupAssignmentCreateSchema = assignmentCreateSchema.omit({ targets: true }).extend({ rooms: confirmedRoomsSchema });

/** POST …/groups/quizzes (JSON). */
export const groupQuizCreateSchema = quizCreateSchema.omit({ targets: true }).extend({ rooms: confirmedRoomsSchema });

/**
 * PATCH …/me/group/quizzes/[quizId]/attempt: some answers (only those
 * questions change; mergeQuizAnswers validates them against the quiz). No
 * revision: members answer different questions at the same time.
 */
export const groupQuizSaveSchema = z.strictObject({ answers: z.unknown() });

/** A form field holding a revision ("0", "1", ...). */
export function parseRevisionField(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]{0,8})$/.test(value)) return -1;
  return Number(value);
}

/** The trusted room directory for the existing create services: exactly the confirmed rooms. */
export function confirmedRoomDirectory(rooms: readonly ConfirmedRoom[]) {
  const listed = rooms.map((room) => ({ id: room.id, name: room.name }));
  return {
    async listBreakoutRooms() {
      return listed.map((room) => ({ ...room }));
    },
  };
}
