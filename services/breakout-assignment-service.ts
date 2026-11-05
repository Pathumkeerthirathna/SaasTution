// Breakout Room Activities: teacher-side assignment service (Phase 2a Step 2).
//
// Every write runs in ONE transaction through runBreakoutTransaction()
// (lib/breakout-activities/locks.ts), in the approved lock order:
//   1. ownership read (another teacher's session = 404, before anything
//      reveals its state), then the session row FOR KEY SHARE, which must be
//      active (409 SESSION_NOT_ACTIVE), then ownership again on the locked row;
//   2. the assignment row FOR UPDATE (state changes, edits, delete).
// A brief PDF is written only after the session lock, inside the
// transaction. If the transaction then fails, the new file is deliberately
// LEFT in place: a failed commit can be ambiguous (the database may have
// committed before the error reached us), and deleting the file would then
// break a committed row. An unreferenced file stays inside the session's
// folder and goes with it at session end (Step 5 cleanup). Only after a
// successful commit is a replaced brief removed, and only when no row
// refers to it any more.
//
// Timestamps (mandatory for every breakout write, including the Step 3
// student services): createdAt, updatedAt, publishedAt and closedAt are
// passed EXPLICITLY from the database clock (serverNow() once before the
// transaction, then serverNowSync()), never left to database defaults or to
// Prisma's @updatedAt, which would use this server's own clock.
//
// The teacher comes from the signed login session (the route passes it);
// rooms come from resolveTargets() (trusted directory, fails closed); nothing
// about either is taken from the client. Every query is scoped to the
// session (and the parent assignment); a soft-deleted (status 1) assignment
// is never shown or changed.
//
// The feature flag is NOT read here: routes gate the API with it.

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { breakoutError, toBreakoutAppError } from "@/lib/breakout-activities/errors";
import { lockActivityForUpdate, requireActiveSessionShared, runBreakoutTransaction, type ActiveSessionLock } from "@/lib/breakout-activities/locks";
import type { UploadedPdf } from "@/lib/breakout-activities/request-body";
import {
  serializeAssignmentForTeacher,
  serializeAssignmentSubmissionForTeacher,
  type AssignmentCounts,
  type StudentRef,
} from "@/lib/breakout-activities/serialize";
import { readBreakoutFile, removeBreakoutFile, writeBreakoutPdf } from "@/lib/breakout-activities/storage";
import { resolveTargets, type TeacherRoomDirectory } from "@/lib/breakout-activities/target-rooms";
import { assertTeacherOwnsLockedSession, requireRouteId, requireTeacherSessionAccess } from "@/lib/breakout-activities/teacher-access";
import type { BreakoutTarget } from "@/lib/breakout-activities/validation";

type Tx = Prisma.TransactionClient;

export type BreakoutServiceOptions = {
  /** Trusted breakout-room directory (Phase 2b); the default fails closed. */
  roomDirectory?: TeacherRoomDirectory;
  /** Storage root override (tests); default <cwd>/storage. */
  storageRoot?: string;
};

// ---- Shared by the breakout teacher services --------------------------------

/** A breakout transaction; expected failures (marking, lock contention) become AppErrors. */
export async function inBreakoutTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await runBreakoutTransaction(prisma, fn);
  } catch (error) {
    throw toBreakoutAppError(error);
  }
}

/**
 * Lock-order level 1 for a teacher write: the teacher's own session (404
 * otherwise, whatever its state), locked FOR KEY SHARE and active (409
 * SESSION_NOT_ACTIVE), ownership confirmed again on the locked row.
 */
export async function lockOwnedActiveSession(tx: Tx, teacherId: string, sessionId: string): Promise<ActiveSessionLock> {
  const access = await requireTeacherSessionAccess(tx, teacherId, sessionId);
  const session = await requireActiveSessionShared(tx, access.sessionId);
  await assertTeacherOwnsLockedSession(tx, session, teacherId);
  return session;
}

// ---- Rules -------------------------------------------------------------------

/** Approved rule: non-empty instructions or a brief, judged on the resulting state. */
function assertInstructionsOrBrief(instructions: string, hasBrief: boolean) {
  if (instructions.trim() === "" && !hasBrief) {
    throw breakoutError("VALIDATION_ERROR", "Add instructions or attach a PDF brief.");
  }
}

const ASSIGNMENT_VIEW_SELECT = {
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

async function studentRefs(db: Pick<Tx, "student">, ids: string[]): Promise<Map<string, StudentRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.student.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, registrationNumber: true } });
  return new Map(rows.map((row) => [row.id, row]));
}

const unknownStudent = (id: string): StudentRef => ({ id, name: "Unknown student", registrationNumber: null });

// ---- Create ------------------------------------------------------------------

export type CreateAssignmentsInput = {
  teacherId: string;
  sessionId: string;
  title: string;
  instructions: string;
  targets: BreakoutTarget[];
  publish: boolean;
  brief: UploadedPdf | null;
};

/**
 * One assignment per target, all sharing one publishGroupId (and one brief
 * file, stored once under briefs/<publishGroupId>/). With publish: true the
 * whole group is published in the same transaction. All or nothing: an
 * unresolvable BREAKOUT target refuses everything (409 ROOM_UNKNOWN).
 */
export async function createAssignments(input: CreateAssignmentsInput, options: BreakoutServiceOptions = {}) {
  assertInstructionsOrBrief(input.instructions, input.brief !== null);
  await serverNow();
  const written: { path?: string; sessionId?: string } = {};
  try {
    const result = await inBreakoutTransaction(async (tx) => {
      const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
      const targets = await resolveTargets(input.targets, { sessionId: session.id, teacherId: input.teacherId }, options.roomDirectory);
      const now = serverNowSync();
      const publishGroupId = randomUUID();

      let brief: { fileName: string; filePath: string; fileSize: number } | null = null;
      if (input.brief) {
        const stored = await writeBreakoutPdf({
          sessionId: session.id,
          kind: "brief",
          activityId: publishGroupId,
          bytes: input.brief.bytes,
          storageRoot: options.storageRoot,
          nowMs: now.getTime(),
        });
        written.path = stored.relativePath;
        written.sessionId = session.id;
        brief = { fileName: input.brief.displayName, filePath: stored.relativePath, fileSize: stored.sizeBytes };
      }

      const assignments = [];
      for (const target of targets) {
        assignments.push(
          await tx.breakoutAssignment.create({
            data: {
              id: randomUUID(),
              classSessionId: session.id,
              teacherId: input.teacherId,
              publishGroupId,
              targetRoomType: target.targetRoomType,
              targetRoomId: target.targetRoomId,
              targetRoomName: target.targetRoomName,
              title: input.title,
              instructions: input.instructions,
              briefFileName: brief?.fileName ?? null,
              briefFilePath: brief?.filePath ?? null,
              briefFileSize: brief?.fileSize ?? null,
              state: input.publish ? "PUBLISHED" : "DRAFT",
              publishedAt: input.publish ? now : null,
              createdAt: now,
              updatedAt: now,
            },
            select: ASSIGNMENT_VIEW_SELECT,
          })
        );
      }
      return { publishGroupId, assignments };
    });
    return { publishGroupId: result.publishGroupId, assignments: result.assignments.map((row) => serializeAssignmentForTeacher(row)) };
  } catch (error) {
    // The new brief (if any) is not deleted here: see the header.
    if (written.path) console.error("Breakout brief left for session cleanup after a failed create.", { sessionId: written.sessionId });
    throw error;
  }
}

// ---- State changes (per activity) ---------------------------------------------

export type AssignmentStateInput = { teacherId: string; sessionId: string; assignmentId: string; action: "publish" | "close" };

/**
 * DRAFT -> PUBLISHED -> CLOSED, this assignment only (other activities of
 * its group are unchanged). Repeating the current state changes nothing.
 * Publish a CLOSED one: 409 ASSIGNMENT_CLOSED; close a DRAFT: 409
 * ACTIVITY_NOT_PUBLISHED.
 */
export async function setAssignmentState(input: AssignmentStateInput) {
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  await serverNow();
  const result = await inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const activity = await lockActivityForUpdate(tx, session, "assignment", assignmentId);
    if (!activity || activity.status !== 0) throw breakoutError("ASSIGNMENT_NOT_FOUND");

    const now = serverNowSync();
    let data: Prisma.BreakoutAssignmentUpdateInput | null = null;
    if (input.action === "publish") {
      if (activity.state === "CLOSED") throw breakoutError("ASSIGNMENT_CLOSED");
      if (activity.state === "DRAFT") data = { state: "PUBLISHED", publishedAt: now, updatedAt: now };
    } else if (input.action === "close") {
      if (activity.state === "DRAFT") throw breakoutError("ACTIVITY_NOT_PUBLISHED");
      if (activity.state === "PUBLISHED") data = { state: "CLOSED", closedAt: now, updatedAt: now };
    } else {
      throw breakoutError("VALIDATION_ERROR", "Unknown action.");
    }

    const row = data
      ? await tx.breakoutAssignment.update({ where: { id: assignmentId }, data, select: ASSIGNMENT_VIEW_SELECT })
      : await tx.breakoutAssignment.findUniqueOrThrow({ where: { id: assignmentId }, select: ASSIGNMENT_VIEW_SELECT });
    return { row, changed: data !== null };
  });
  return { assignment: serializeAssignmentForTeacher(result.row), changed: result.changed };
}

// ---- DRAFT edits ---------------------------------------------------------------

export type EditAssignmentInput = {
  teacherId: string;
  sessionId: string;
  assignmentId: string;
  title?: string;
  instructions?: string;
  /** A replacement brief (multipart PATCH). Removing a brief is not supported. */
  brief?: UploadedPdf | null;
};

/**
 * Edits a DRAFT (PUBLISHED: 409 ACTIVITY_NOT_DRAFT; CLOSED: 409
 * ASSIGNMENT_CLOSED). The instructions-or-brief rule is checked on the
 * result. A replacement brief is stored for this assignment alone
 * (briefs/<assignmentId>/); the previous file is removed after the commit
 * only when no other assignment row still refers to it.
 */
export async function editAssignment(input: EditAssignmentInput, options: BreakoutServiceOptions = {}) {
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  if (input.title === undefined && input.instructions === undefined && !input.brief) {
    throw breakoutError("VALIDATION_ERROR", "Nothing to change.");
  }
  await serverNow();
  const written: { path?: string; sessionId?: string } = {};
  try {
    const result = await inBreakoutTransaction(async (tx) => {
      const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
      const activity = await lockActivityForUpdate(tx, session, "assignment", assignmentId);
      if (!activity || activity.status !== 0) throw breakoutError("ASSIGNMENT_NOT_FOUND");
      if (activity.state === "CLOSED") throw breakoutError("ASSIGNMENT_CLOSED");
      if (activity.state !== "DRAFT") throw breakoutError("ACTIVITY_NOT_DRAFT");

      const current = await tx.breakoutAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        select: { instructions: true, briefFilePath: true },
      });
      const instructions = input.instructions ?? current.instructions;
      assertInstructionsOrBrief(instructions, Boolean(input.brief) || current.briefFilePath !== null);

      const now = serverNowSync();
      const data: Prisma.BreakoutAssignmentUpdateInput = { updatedAt: now };
      if (input.title !== undefined) data.title = input.title;
      if (input.instructions !== undefined) data.instructions = input.instructions;

      let previousBrief: string | null = null;
      if (input.brief) {
        const stored = await writeBreakoutPdf({
          sessionId: session.id,
          kind: "brief",
          activityId: assignmentId,
          bytes: input.brief.bytes,
          storageRoot: options.storageRoot,
          nowMs: now.getTime(),
        });
        written.path = stored.relativePath;
        written.sessionId = session.id;
        data.briefFileName = input.brief.displayName;
        data.briefFilePath = stored.relativePath;
        data.briefFileSize = stored.sizeBytes;
        previousBrief = current.briefFilePath;
      }

      const row = await tx.breakoutAssignment.update({ where: { id: assignmentId }, data, select: ASSIGNMENT_VIEW_SELECT });

      // The old file may still be shared with the rest of its group (any status).
      let removePrevious: string | null = null;
      if (previousBrief) {
        const stillUsed = await tx.breakoutAssignment.count({
          where: { classSessionId: session.id, briefFilePath: previousBrief, id: { not: assignmentId } },
        });
        if (stillUsed === 0) removePrevious = previousBrief;
      }
      return { row, removePrevious, sessionId: session.id };
    });
    // Committed: the replaced brief goes now, if nothing refers to it any more.
    if (result.removePrevious) await removeBreakoutFile(result.removePrevious, result.sessionId, options.storageRoot);
    return { assignment: serializeAssignmentForTeacher(result.row) };
  } catch (error) {
    // The new brief (if any) is not deleted here: see the header.
    if (written.path) console.error("Breakout brief left for session cleanup after a failed edit.", { sessionId: written.sessionId });
    throw error;
  }
}

// ---- Delete (soft) -------------------------------------------------------------

export type DeleteAssignmentInput = { teacherId: string; sessionId: string; assignmentId: string };

/**
 * Soft-deletes a DRAFT (status = 1; still counted in the session summary
 * and removed with the session). PUBLISHED: 409 ACTIVITY_NOT_DRAFT; CLOSED:
 * 409 ASSIGNMENT_CLOSED; already deleted: 404.
 */
export async function deleteAssignment(input: DeleteAssignmentInput) {
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  await serverNow();
  return inBreakoutTransaction(async (tx) => {
    const session = await lockOwnedActiveSession(tx, input.teacherId, input.sessionId);
    const activity = await lockActivityForUpdate(tx, session, "assignment", assignmentId);
    if (!activity || activity.status !== 0) throw breakoutError("ASSIGNMENT_NOT_FOUND");
    if (activity.state === "CLOSED") throw breakoutError("ASSIGNMENT_CLOSED");
    if (activity.state !== "DRAFT") throw breakoutError("ACTIVITY_NOT_DRAFT");
    await tx.breakoutAssignment.update({ where: { id: assignmentId }, data: { status: 1, updatedAt: serverNowSync() } });
    return { id: assignmentId, status: 1 as const };
  });
}

// ---- Reads (no transaction; ownership checked; any session state) ---------------

/** The session's assignments (not deleted), oldest first, with counts. */
export async function listAssignmentsForTeacher(teacherId: string, sessionId: string) {
  const access = await requireTeacherSessionAccess(prisma, teacherId, sessionId);
  const rows = await prisma.breakoutAssignment.findMany({
    where: { classSessionId: access.sessionId, status: 0 },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: ASSIGNMENT_VIEW_SELECT,
  });
  const ids = rows.map((row) => row.id);
  const counts = new Map<string, AssignmentCounts>(ids.map((id) => [id, { studentsSubmitted: 0, submissions: 0, drafts: 0 }]));
  if (ids.length > 0) {
    const [submissions, drafts] = await Promise.all([
      prisma.breakoutAssignmentSubmission.findMany({
        where: { classSessionId: access.sessionId, assignmentId: { in: ids } },
        select: { assignmentId: true, isLatest: true },
      }),
      prisma.breakoutAssignmentDraft.findMany({
        where: { classSessionId: access.sessionId, assignmentId: { in: ids } },
        select: { assignmentId: true },
      }),
    ]);
    for (const s of submissions) {
      const c = counts.get(s.assignmentId);
      if (!c) continue;
      c.submissions += 1;
      if (s.isLatest) c.studentsSubmitted += 1;
    }
    for (const d of drafts) {
      const c = counts.get(d.assignmentId);
      if (c) c.drafts += 1;
    }
  }
  return { assignments: rows.map((row) => serializeAssignmentForTeacher(row, counts.get(row.id))) };
}

async function requireOwnedAssignment(teacherId: string, sessionId: string, assignmentId: string) {
  const access = await requireTeacherSessionAccess(prisma, teacherId, sessionId);
  const id = requireRouteId(assignmentId, "ASSIGNMENT_NOT_FOUND");
  const assignment = await prisma.breakoutAssignment.findFirst({
    where: { id, classSessionId: access.sessionId, status: 0 },
    select: { id: true, briefFileName: true, briefFilePath: true },
  });
  if (!assignment) throw breakoutError("ASSIGNMENT_NOT_FOUND");
  return { sessionId: access.sessionId, assignment };
}

/**
 * Submissions of one assignment: the latest version of each student with
 * the number of versions, or with `studentId` that student's full history
 * (newest first).
 */
export async function listAssignmentSubmissionsForTeacher(input: {
  teacherId: string;
  sessionId: string;
  assignmentId: string;
  studentId?: string;
}) {
  const { sessionId, assignment } = await requireOwnedAssignment(input.teacherId, input.sessionId, input.assignmentId);
  const select = {
    id: true,
    studentId: true,
    version: true,
    isLatest: true,
    answerText: true,
    fileName: true,
    fileSize: true,
    submittedAt: true,
  } as const;

  if (input.studentId !== undefined) {
    const studentId = requireRouteId(input.studentId, "NOT_FOUND");
    const rows = await prisma.breakoutAssignmentSubmission.findMany({
      where: { assignmentId: assignment.id, classSessionId: sessionId, studentId },
      orderBy: { version: "desc" },
      select,
    });
    const students = await studentRefs(prisma, [studentId]);
    const student = students.get(studentId) ?? unknownStudent(studentId);
    return { submissions: rows.map((row) => serializeAssignmentSubmissionForTeacher({ ...row, student })) };
  }

  const rows = await prisma.breakoutAssignmentSubmission.findMany({
    where: { assignmentId: assignment.id, classSessionId: sessionId },
    orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
    select,
  });
  const versionCounts = new Map<string, number>();
  for (const row of rows) versionCounts.set(row.studentId, (versionCounts.get(row.studentId) ?? 0) + 1);
  const latest = rows.filter((row) => row.isLatest);
  const students = await studentRefs(prisma, latest.map((row) => row.studentId));
  return {
    submissions: latest.map((row) =>
      serializeAssignmentSubmissionForTeacher(
        { ...row, student: students.get(row.studentId) ?? unknownStudent(row.studentId) },
        { versionCount: versionCounts.get(row.studentId) ?? 1 }
      )
    ),
  };
}

export type BreakoutPdfDownload = { bytes: Uint8Array; displayName: string; sizeBytes: number };

/** The assignment's brief PDF. 404 FILE_NOT_FOUND when it has none or it is gone. */
export async function getAssignmentBriefForTeacher(
  input: { teacherId: string; sessionId: string; assignmentId: string },
  options: BreakoutServiceOptions = {}
): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireOwnedAssignment(input.teacherId, input.sessionId, input.assignmentId);
  if (!assignment.briefFilePath) throw breakoutError("FILE_NOT_FOUND");
  const bytes = await readBreakoutFile(assignment.briefFilePath, sessionId, options.storageRoot);
  return { bytes, displayName: assignment.briefFileName ?? "brief.pdf", sizeBytes: bytes.byteLength };
}

/** One submission's PDF, only if it belongs to this assignment in this session. */
export async function getAssignmentSubmissionFileForTeacher(
  input: { teacherId: string; sessionId: string; assignmentId: string; submissionId: string },
  options: BreakoutServiceOptions = {}
): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireOwnedAssignment(input.teacherId, input.sessionId, input.assignmentId);
  const submissionId = requireRouteId(input.submissionId, "NOT_FOUND");
  const submission = await prisma.breakoutAssignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId: assignment.id, classSessionId: sessionId },
    select: { fileName: true, filePath: true },
  });
  if (!submission) throw breakoutError("NOT_FOUND");
  if (!submission.filePath) throw breakoutError("FILE_NOT_FOUND");
  const bytes = await readBreakoutFile(submission.filePath, sessionId, options.storageRoot);
  return { bytes, displayName: submission.fileName ?? "submission.pdf", sizeBytes: bytes.byteLength };
}
