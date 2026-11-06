// Breakout Group Activities: group assignments.
//
// A GROUP assignment row targets exactly one breakout room, so it has one
// group: the room's confirmed members (BreakoutRoomMember). The group shares
// ONE workspace (BreakoutGroupAssignmentWork): one answer text, saved with
// the existing revision rule (a stale revision is 409 REVISION_CONFLICT with
// the current text: reload and try again), the latest editor and time, and
// ONE final submission (text and/or the existing PDF handling) made by any
// confirmed member. The submission is final in version 1: a repeat returns
// it (replayed), nobody can change the work afterwards.
//
// Creation reuses the existing createAssignments() service unchanged in
// behaviour: workMode GROUP, and the trusted room directory built from the
// teacher-confirmed rooms (validation.ts confirmedRoomDirectory), so the
// existing global room directory default (fail closed) is never changed.
// Publish / close / edit / delete use the existing teacher routes.
//
// Student writes, in lock order (lib/breakout-activities/groups/locks.ts):
// session FOR KEY SHARE and enrolment (lockEnrolledActiveSession), the
// membership lock SHARED and the active membership, the assignment row FOR
// KEY SHARE (lockActivityShared: a teacher close waits for in-flight writes),
// then the group-activity lock (one write of the group at a time).
// Timestamps from the database clock (serverNow before, serverNowSync inside).
// Files: like the existing submissions (F2), a PDF is written only after the
// locks; if the transaction then fails it is left for session cleanup.

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { breakoutError, pdfCheckError } from "@/lib/breakout-activities/errors";
import { lockActivityShared } from "@/lib/breakout-activities/locks";
import { MAX_BREAKOUT_PDF_BYTES, sanitizeDisplayName, validatePdfUpload } from "@/lib/breakout-activities/pdf-file";
import type { UploadedPdf } from "@/lib/breakout-activities/request-body";
import { serializeAssignmentForStudent, serializeAssignmentForTeacher } from "@/lib/breakout-activities/serialize";
import { readBreakoutFile, writeBreakoutPdf } from "@/lib/breakout-activities/storage";
import { checkSubmissionContent, MAX_ANSWER_TEXT_LENGTH } from "@/lib/breakout-activities/submission-rules.mjs";
import { requireRouteId, requireTeacherSessionAccess } from "@/lib/breakout-activities/teacher-access";
import { activeMemberIds, lockStudentGroup, requireStudentGroup, studentNames, type GroupMembership } from "@/lib/breakout-activities/groups/access";
import { groupError } from "@/lib/breakout-activities/groups/errors";
import { emitGroupChange } from "@/lib/breakout-activities/groups/events";
import { lockGroupActivity } from "@/lib/breakout-activities/groups/locks";
import { nameLookup, serializeGroupWork } from "@/lib/breakout-activities/groups/serialize";
import { confirmedRoomDirectory, type ConfirmedRoom } from "@/lib/breakout-activities/groups/validation";

import { createAssignments, inBreakoutTransaction } from "./breakout-assignment-service";
import { confirmGroupMembers } from "./breakout-group-membership-service";

type Tx = Prisma.TransactionClient;

export type GroupServiceOptions = { /** Storage root override (tests); default <cwd>/storage. */ storageRoot?: string };

const VISIBLE_STATES = ["PUBLISHED", "CLOSED"] as const;

const ASSIGNMENT_SELECT = {
  id: true,
  publishGroupId: true,
  targetRoomType: true,
  targetRoomId: true,
  targetRoomName: true,
  title: true,
  instructions: true,
  briefFileName: true,
  briefFileSize: true,
  state: true,
  publishedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const WORK_SELECT = {
  id: true,
  answerText: true,
  revision: true,
  lastEditedByStudentId: true,
  lastEditedAt: true,
  submittedAt: true,
  submittedByStudentId: true,
  memberStudentIds: true,
  fileName: true,
  fileSize: true,
} as const;

const notVisible = () => breakoutError("ASSIGNMENT_NOT_FOUND");

/** The visible GROUP assignment of the student's room (PUBLISHED / CLOSED, not deleted). */
function visibleWhere(id: string, sessionId: string, membership: GroupMembership) {
  return {
    id,
    classSessionId: sessionId,
    status: 0,
    state: { in: [...VISIBLE_STATES] },
    workMode: "GROUP" as const,
    targetRoomType: "BREAKOUT" as const,
    targetRoomId: membership.roomId,
  };
}

async function workView(db: Pick<Tx, "student" | "breakoutRoomMember">, sessionId: string, roomId: string, work: (Prisma.BreakoutGroupAssignmentWorkGetPayload<{ select: typeof WORK_SELECT }>) | null) {
  const members = await activeMemberIds(db, sessionId, roomId);
  const snapshot = Array.isArray(work?.memberStudentIds) ? (work?.memberStudentIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
  const names = await studentNames(db, [...members, ...snapshot, work?.lastEditedByStudentId, work?.submittedByStudentId]);
  const nameOf = nameLookup(names);
  return { members: members.map((id) => nameOf(id)), work: serializeGroupWork(work, nameOf) };
}

// ---- Teacher: create -------------------------------------------------------------

export type CreateGroupAssignmentsInput = {
  teacherId: string;
  sessionId: string;
  title: string;
  instructions: string;
  rooms: ConfirmedRoom[];
  publish: boolean;
  brief: UploadedPdf | null;
};

/**
 * Confirms the members of the chosen existing rooms, then creates one GROUP
 * assignment per room with the existing createAssignments() (one
 * publishGroupId, one shared brief), using exactly the confirmed rooms as
 * its trusted room directory.
 */
export async function createGroupAssignments(input: CreateGroupAssignmentsInput, options: GroupServiceOptions = {}) {
  const members = await confirmGroupMembers({ teacherId: input.teacherId, sessionId: input.sessionId, rooms: input.rooms });
  const created = await createAssignments(
    {
      teacherId: input.teacherId,
      sessionId: input.sessionId,
      title: input.title,
      instructions: input.instructions,
      targets: input.rooms.map((room) => ({ type: "BREAKOUT" as const, id: room.id })),
      publish: input.publish,
      brief: input.brief,
      workMode: "GROUP",
    },
    { roomDirectory: confirmedRoomDirectory(input.rooms), storageRoot: options.storageRoot }
  );
  return { ...created, rooms: members.rooms };
}

// ---- Student: reads ---------------------------------------------------------------

async function requireVisibleGroupAssignment(studentId: string, sessionId: string, assignmentId: string) {
  const access = await requireStudentGroup(prisma, studentId, sessionId);
  const id = requireRouteId(assignmentId, "ASSIGNMENT_NOT_FOUND");
  const assignment = await prisma.breakoutAssignment.findFirst({
    where: visibleWhere(id, access.sessionId, access.membership),
    select: { ...ASSIGNMENT_SELECT, briefFilePath: true },
  });
  if (!assignment) throw notVisible();
  return { ...access, assignment };
}

/** One group assignment of the student's group: instructions, members, the shared work and the final submission. */
export async function getGroupAssignmentForStudent(input: { studentId: string; sessionId: string; assignmentId: string }) {
  const { sessionId, membership, assignment } = await requireVisibleGroupAssignment(input.studentId, input.sessionId, input.assignmentId);
  const work = await prisma.breakoutGroupAssignmentWork.findFirst({ where: { assignmentId: assignment.id, classSessionId: sessionId }, select: WORK_SELECT });
  const view = await workView(prisma, sessionId, membership.roomId, work);
  return {
    assignment: serializeAssignmentForStudent(assignment),
    group: { room: { id: membership.roomId, name: membership.roomName }, members: view.members },
    work: view.work,
  };
}

export type BreakoutPdfDownload = { bytes: Uint8Array; displayName: string; sizeBytes: number };

/** The brief PDF of a group assignment of the student's group. */
export async function getGroupAssignmentBriefForStudent(input: { studentId: string; sessionId: string; assignmentId: string }, options: GroupServiceOptions = {}): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireVisibleGroupAssignment(input.studentId, input.sessionId, input.assignmentId);
  if (!assignment.briefFilePath) throw breakoutError("FILE_NOT_FOUND");
  const bytes = await readBreakoutFile(assignment.briefFilePath, sessionId, options.storageRoot);
  return { bytes, displayName: assignment.briefFileName ?? "brief.pdf", sizeBytes: bytes.byteLength };
}

/** The PDF of the group's final submission (members of the group only). */
export async function getGroupSubmissionFileForStudent(input: { studentId: string; sessionId: string; assignmentId: string }, options: GroupServiceOptions = {}): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireVisibleGroupAssignment(input.studentId, input.sessionId, input.assignmentId);
  return readSubmissionFile(sessionId, assignment.id, options);
}

async function readSubmissionFile(sessionId: string, assignmentId: string, options: GroupServiceOptions): Promise<BreakoutPdfDownload> {
  const work = await prisma.breakoutGroupAssignmentWork.findFirst({
    where: { assignmentId, classSessionId: sessionId },
    select: { submittedAt: true, fileName: true, filePath: true },
  });
  if (!work?.submittedAt || !work.filePath) throw breakoutError("FILE_NOT_FOUND");
  const bytes = await readBreakoutFile(work.filePath, sessionId, options.storageRoot);
  return { bytes, displayName: work.fileName ?? "submission.pdf", sizeBytes: bytes.byteLength };
}

// ---- Student: writes ----------------------------------------------------------------

async function lockWritableGroupAssignment(tx: Tx, studentId: string, sessionId: string, assignmentId: string) {
  const { session, membership } = await lockStudentGroup(tx, studentId, sessionId);
  const assignment = await lockActivityShared(tx, session, "assignment", assignmentId);
  if (
    !assignment ||
    assignment.status !== 0 ||
    assignment.state === "DRAFT" ||
    assignment.targetRoomType !== "BREAKOUT" ||
    assignment.targetRoomId !== membership.roomId
  ) {
    throw notVisible();
  }
  const mode = await tx.breakoutAssignment.findUnique({ where: { id: assignment.id }, select: { workMode: true } });
  if (mode?.workMode !== "GROUP") throw notVisible();
  await lockGroupActivity(tx, session, "assignment", assignment.id);
  const work = await tx.breakoutGroupAssignmentWork.findFirst({ where: { assignmentId: assignment.id, classSessionId: session.id }, select: WORK_SELECT });
  return { session, membership, assignment, work };
}

export type SaveGroupWorkInput = { studentId: string; sessionId: string; assignmentId: string; revision: number; answerText: string };

/**
 * Saves the group's shared answer text. `revision` is the one the student
 * last saw (0 before the first save); a different stored revision is 409
 * REVISION_CONFLICT with the current text, revision and latest editor (the
 * client reloads). CLOSED: 409 ASSIGNMENT_CLOSED; already submitted: 409
 * GROUP_WORK_SUBMITTED.
 */
export async function saveGroupAssignmentWork(input: SaveGroupWorkInput) {
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  if (!Number.isInteger(input.revision) || input.revision < 0) throw breakoutError("VALIDATION_ERROR", "Invalid revision.");
  if (typeof input.answerText !== "string") throw breakoutError("VALIDATION_ERROR", "Invalid answer text.");
  if (input.answerText.length > MAX_ANSWER_TEXT_LENGTH) throw breakoutError("ANSWER_TEXT_TOO_LONG");
  await serverNow();

  const result = await inBreakoutTransaction(async (tx) => {
    const { session, membership, assignment, work } = await lockWritableGroupAssignment(tx, input.studentId, input.sessionId, assignmentId);
    if (assignment.state === "CLOSED") throw breakoutError("ASSIGNMENT_CLOSED");
    if (work?.submittedAt) throw groupError("GROUP_WORK_SUBMITTED");
    const storedRevision = work?.revision ?? 0;
    if (storedRevision !== input.revision) {
      const view = await workView(tx, session.id, membership.roomId, work);
      throw breakoutError("REVISION_CONFLICT", undefined, { work: view.work });
    }
    const now = serverNowSync();
    const saved = work
      ? await tx.breakoutGroupAssignmentWork.update({
          where: { id: work.id },
          data: { answerText: input.answerText, revision: work.revision + 1, lastEditedByStudentId: input.studentId, lastEditedAt: now, updatedAt: now },
          select: WORK_SELECT,
        })
      : await tx.breakoutGroupAssignmentWork.create({
          data: {
            id: randomUUID(),
            assignmentId: assignment.id,
            classSessionId: session.id,
            answerText: input.answerText,
            revision: 1,
            lastEditedByStudentId: input.studentId,
            lastEditedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          select: WORK_SELECT,
        });
    const view = await workView(tx, session.id, membership.roomId, saved);
    return { sessionId: session.id, roomId: membership.roomId, assignmentId: assignment.id, revision: saved.revision, members: view.members, work: view.work };
  });

  notify(result.sessionId, "assignment", result.assignmentId, result.roomId, result.revision, result.members);
  return { work: result.work };
}

/** A file part as received, not yet checked as a PDF (only its size, before the replay check). */
export type RawGroupSubmissionFile = { bytes: Uint8Array; fileName: string; mimeType: string };

export type SubmitGroupAssignmentInput = {
  studentId: string;
  sessionId: string;
  assignmentId: string;
  /** The work revision the student last saw: the group submits exactly what they confirmed. */
  revision: number;
  file: RawGroupSubmissionFile | null;
};

/**
 * Makes the group's ONE final submission: the saved shared text (as it is
 * at `revision`) and/or a PDF, by any confirmed member. Records the
 * submitting student, the time and the confirmed members at that moment.
 *
 * Final and idempotent: once submitted, every repeat (any member, any body,
 * also after the assignment closed) returns the stored submission with
 * replayed: true, writes nothing and stores no file. Otherwise: CLOSED 409
 * ASSIGNMENT_CLOSED; a stale revision 409 REVISION_CONFLICT; no text and no
 * PDF 400 SUBMISSION_EMPTY; a bad PDF 400 INVALID_PDF / 413 FILE_TOO_LARGE.
 */
export async function submitGroupAssignment(input: SubmitGroupAssignmentInput, options: GroupServiceOptions = {}) {
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  if (!Number.isInteger(input.revision) || input.revision < 0) throw breakoutError("VALIDATION_ERROR", "Invalid revision.");
  if (input.file !== null) {
    if (!input.file || !(input.file.bytes instanceof Uint8Array) || typeof input.file.fileName !== "string" || typeof input.file.mimeType !== "string") {
      throw breakoutError("VALIDATION_ERROR", "Invalid file.");
    }
    if (input.file.bytes.byteLength > MAX_BREAKOUT_PDF_BYTES) throw breakoutError("FILE_TOO_LARGE");
  }
  await serverNow();

  const written: { path?: string; sessionId?: string } = {};
  try {
    const result = await inBreakoutTransaction(async (tx) => {
      const { session, membership, assignment, work } = await lockWritableGroupAssignment(tx, input.studentId, input.sessionId, assignmentId);

      // Final: a repeat gets the stored submission, whatever it carries.
      if (work?.submittedAt) {
        const view = await workView(tx, session.id, membership.roomId, work);
        return { replayed: true as const, view };
      }
      if (assignment.state === "CLOSED") throw breakoutError("ASSIGNMENT_CLOSED");
      if ((work?.revision ?? 0) !== input.revision) {
        const view = await workView(tx, session.id, membership.roomId, work);
        throw breakoutError("REVISION_CONFLICT", undefined, { work: view.work });
      }

      const content = checkSubmissionContent({ answerText: work?.answerText ?? null, hasFile: input.file !== null });
      if (!content.ok) throw breakoutError(content.code);
      if (input.file) {
        const pdfCheck = validatePdfUpload(input.file.bytes, input.file.mimeType);
        if (!pdfCheck.ok) throw pdfCheckError(pdfCheck.code);
      }

      const now = serverNowSync();
      const members = await activeMemberIds(tx, session.id, membership.roomId);
      let file: { fileName: string; filePath: string; fileSize: number } | null = null;
      if (input.file) {
        const stored = await writeBreakoutPdf({
          sessionId: session.id,
          kind: "submission",
          activityId: assignment.id,
          bytes: input.file.bytes,
          storageRoot: options.storageRoot,
          nowMs: now.getTime(),
        });
        written.path = stored.relativePath;
        written.sessionId = session.id;
        file = { fileName: sanitizeDisplayName(input.file.fileName), filePath: stored.relativePath, fileSize: stored.sizeBytes };
      }

      const submission = {
        submittedAt: now,
        submittedByStudentId: input.studentId,
        memberStudentIds: members as unknown as Prisma.InputJsonValue,
        fileName: file?.fileName ?? null,
        filePath: file?.filePath ?? null,
        fileSize: file?.fileSize ?? null,
        updatedAt: now,
      };
      const saved = work
        ? await tx.breakoutGroupAssignmentWork.update({ where: { id: work.id }, data: submission, select: WORK_SELECT })
        : await tx.breakoutGroupAssignmentWork.create({
            data: { id: randomUUID(), assignmentId: assignment.id, classSessionId: session.id, answerText: "", revision: 0, createdAt: now, ...submission },
            select: WORK_SELECT,
          });
      const view = await workView(tx, session.id, membership.roomId, saved);
      return { replayed: false as const, view, sessionId: session.id, roomId: membership.roomId, revision: saved.revision };
    });

    if (!result.replayed) {
      notify(result.sessionId, "assignment", assignmentId, result.roomId, result.revision, result.view.members);
    }
    return { work: result.view.work, replayed: result.replayed };
  } catch (error) {
    if (written.path) console.error("Breakout group submission file left for session cleanup after a failed submit.", { sessionId: written.sessionId });
    throw error;
  }
}

function notify(sessionId: string, kind: "assignment" | "quiz", activityId: string, roomId: string, revision: number, members: ({ id: string } | null)[]) {
  emitGroupChange({
    sessionId,
    kind,
    activityId,
    roomId,
    revision,
    memberStudentIds: members.filter((m): m is { id: string } => m !== null).map((m) => m.id),
  });
}

// ---- Teacher: reads ------------------------------------------------------------------

async function requireOwnedGroupAssignment(teacherId: string, sessionId: string, assignmentId: string) {
  const access = await requireTeacherSessionAccess(prisma, teacherId, sessionId);
  const id = requireRouteId(assignmentId, "ASSIGNMENT_NOT_FOUND");
  const assignment = await prisma.breakoutAssignment.findFirst({
    where: { id, classSessionId: access.sessionId, status: 0, workMode: "GROUP" },
    select: ASSIGNMENT_SELECT,
  });
  if (!assignment) throw breakoutError("ASSIGNMENT_NOT_FOUND");
  return { sessionId: access.sessionId, assignment };
}

/** The teacher's view of one group assignment: the room's confirmed members, the shared work and the final submission. */
export async function getGroupAssignmentForTeacher(input: { teacherId: string; sessionId: string; assignmentId: string }) {
  const { sessionId, assignment } = await requireOwnedGroupAssignment(input.teacherId, input.sessionId, input.assignmentId);
  const work = await prisma.breakoutGroupAssignmentWork.findFirst({ where: { assignmentId: assignment.id, classSessionId: sessionId }, select: WORK_SELECT });
  const view = await workView(prisma, sessionId, assignment.targetRoomId ?? "", work);
  return { assignment: serializeAssignmentForTeacher(assignment), members: view.members, work: view.work };
}

/** The final submission's PDF, for the session's own teacher. */
export async function getGroupSubmissionFileForTeacher(input: { teacherId: string; sessionId: string; assignmentId: string }, options: GroupServiceOptions = {}): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireOwnedGroupAssignment(input.teacherId, input.sessionId, input.assignmentId);
  return readSubmissionFile(sessionId, assignment.id, options);
}
