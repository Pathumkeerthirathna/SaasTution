// Breakout Room Activities: student-side assignment service (Stage 3.1).
//
// Who: the student id always comes from the signed login session (the route
// passes it); a studentId in a request is never used. Access needs an active
// session and an active enrolment in its class (student-access.ts); every
// failure is the same 404 (approved decision D2).
//
// Which room: the injected StudentRoomResolver (room-resolver.ts). The
// default fails closed, so until Phase 2b supplies the roster every call
// here is 404. A client-sent room id is never used. A student sees only
// PUBLISHED / CLOSED, non-deleted assignments that target their CURRENT
// room, and only their own work on them (D6: previous-room history hidden).
// Anything else is 404 ASSIGNMENT_NOT_FOUND: a draft, another room, another
// session and a missing id cannot be told apart.
//
// Writes run in one transaction (inBreakoutTransaction), in the approved
// lock order (Stage 3.0, D4):
//   1. session row FOR KEY SHARE, enrolment re-checked on the locked row
//      (lockEnrolledActiveSession);
//   2. the room, resolved now, inside the transaction;
//   3. assignment row FOR KEY SHARE (lockActivityShared): a teacher close
//      (FOR UPDATE) waits for in-flight writes, later writes see CLOSED;
//   4. the (assignment, student) advisory lock (lockStudentSubmissionSlot);
//   5. the write.
// Timestamps from the database clock: serverNow() before the transaction,
// serverNowSync() inside; createdAt / updatedAt / submittedAt explicit.
// (BreakoutAssignmentSubmission has no updatedAt column: submittedAt is set
// explicitly; the isLatest flip always comes with an insert, D7.)
//
// Files (F2): a submission PDF is written only after the locks; if the
// transaction then fails it is LEFT for the session-end cleanup (a failed
// commit may be ambiguous), never deleted here.

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { breakoutError, pdfCheckError } from "@/lib/breakout-activities/errors";
import { lockActivityShared, lockStudentSubmissionSlot } from "@/lib/breakout-activities/locks";
import { MAX_BREAKOUT_PDF_BYTES, sanitizeDisplayName, validatePdfUpload } from "@/lib/breakout-activities/pdf-file";
import {
  activityTargetsRoom,
  defaultStudentRoomResolver,
  requireStudentRoom,
  type StudentRoom,
  type StudentRoomResolver,
} from "@/lib/breakout-activities/room-resolver";
import {
  serializeAssignmentForStudent,
  serializeDraftForStudent,
  serializeSubmissionForStudent,
} from "@/lib/breakout-activities/serialize";
import { readBreakoutFile, writeBreakoutPdf } from "@/lib/breakout-activities/storage";
import { lockEnrolledActiveSession, requireEnrolledStudentSessionAccess } from "@/lib/breakout-activities/student-access";
import {
  assertSingleLatest,
  checkSubmissionContent,
  decideSubmission,
  isIdempotencyKey,
  MAX_ANSWER_TEXT_LENGTH,
} from "@/lib/breakout-activities/submission-rules.mjs";
import { requireRouteId } from "@/lib/breakout-activities/teacher-access";

import { inBreakoutTransaction } from "./breakout-assignment-service";

type Tx = Prisma.TransactionClient;

export type StudentServiceOptions = {
  /** Trusted room resolution (Phase 2b); the default fails closed (404). */
  roomResolver?: StudentRoomResolver;
  /** Storage root override (tests); default <cwd>/storage. */
  storageRoot?: string;
};

const VISIBLE_STATES = ["PUBLISHED", "CLOSED"] as const;

const ASSIGNMENT_STUDENT_SELECT = {
  id: true,
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
} as const;

const SUBMISSION_STUDENT_SELECT = {
  id: true,
  version: true,
  isLatest: true,
  answerText: true,
  fileName: true,
  fileSize: true,
  submittedAt: true,
} as const;

const notVisible = () => breakoutError("ASSIGNMENT_NOT_FOUND");

/** Prisma filter for "targets this room" (the same rule as activityTargetsRoom). */
function roomFilter(room: StudentRoom) {
  return room.type === "MAIN" ? { targetRoomType: "MAIN" as const } : { targetRoomType: "BREAKOUT" as const, targetRoomId: room.id };
}

// ---- Reads (no transaction) --------------------------------------------------

/** Access, room, and one visible assignment of this session (404 otherwise). */
async function requireVisibleAssignment(studentId: string, sessionId: string, assignmentId: string, options: StudentServiceOptions) {
  const access = await requireEnrolledStudentSessionAccess(prisma, studentId, sessionId);
  const room = await requireStudentRoom({ sessionId: access.sessionId, studentId }, options.roomResolver ?? defaultStudentRoomResolver);
  const id = requireRouteId(assignmentId, "ASSIGNMENT_NOT_FOUND");
  const assignment = await prisma.breakoutAssignment.findFirst({
    where: { id, classSessionId: access.sessionId, status: 0, state: { in: [...VISIBLE_STATES] } },
    select: { ...ASSIGNMENT_STUDENT_SELECT, briefFilePath: true },
  });
  if (!assignment || !activityTargetsRoom(assignment, room)) throw notVisible();
  return { sessionId: access.sessionId, room, assignment };
}

/**
 * The assignments of the student's current room (oldest first), each with
 * the student's own draft state and latest submission.
 */
export async function listAssignmentsForStudent(input: { studentId: string; sessionId: string }, options: StudentServiceOptions = {}) {
  const access = await requireEnrolledStudentSessionAccess(prisma, input.studentId, input.sessionId);
  const room = await requireStudentRoom({ sessionId: access.sessionId, studentId: input.studentId }, options.roomResolver ?? defaultStudentRoomResolver);
  const rows = (
    await prisma.breakoutAssignment.findMany({
      where: { classSessionId: access.sessionId, status: 0, state: { in: [...VISIBLE_STATES] }, ...roomFilter(room) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: ASSIGNMENT_STUDENT_SELECT,
    })
  ).filter((row) => activityTargetsRoom(row, room));
  const ids = rows.map((row) => row.id);
  const [drafts, latest] = ids.length
    ? await Promise.all([
        prisma.breakoutAssignmentDraft.findMany({
          where: { classSessionId: access.sessionId, studentId: input.studentId, assignmentId: { in: ids } },
          select: { assignmentId: true, revision: true, updatedAt: true },
        }),
        prisma.breakoutAssignmentSubmission.findMany({
          where: { classSessionId: access.sessionId, studentId: input.studentId, assignmentId: { in: ids }, isLatest: true },
          select: { ...SUBMISSION_STUDENT_SELECT, assignmentId: true },
        }),
      ])
    : [[], []];
  const draftOf = new Map(drafts.map((d) => [d.assignmentId, d]));
  const latestOf = new Map(latest.map((s) => [s.assignmentId, s]));
  return {
    room: { type: room.type },
    assignments: rows.map((row) => {
      const draft = draftOf.get(row.id);
      const submission = latestOf.get(row.id);
      return {
        ...serializeAssignmentForStudent(row),
        mine: {
          draft: draft ? { revision: draft.revision, updatedAt: draft.updatedAt.toISOString() } : null,
          latestSubmission: submission ? serializeSubmissionForStudent(submission) : null,
        },
      };
    }),
  };
}

export type BreakoutPdfDownload = { bytes: Uint8Array; displayName: string; sizeBytes: number };

/** The brief PDF of a visible assignment. */
export async function getAssignmentBriefForStudent(
  input: { studentId: string; sessionId: string; assignmentId: string },
  options: StudentServiceOptions = {}
): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireVisibleAssignment(input.studentId, input.sessionId, input.assignmentId, options);
  if (!assignment.briefFilePath) throw breakoutError("FILE_NOT_FOUND");
  const bytes = await readBreakoutFile(assignment.briefFilePath, sessionId, options.storageRoot);
  return { bytes, displayName: assignment.briefFileName ?? "brief.pdf", sizeBytes: bytes.byteLength };
}

/** The student's own draft (empty at revision 0 when there is none). */
export async function getDraftForStudent(input: { studentId: string; sessionId: string; assignmentId: string }, options: StudentServiceOptions = {}) {
  const { sessionId, assignment } = await requireVisibleAssignment(input.studentId, input.sessionId, input.assignmentId, options);
  const draft = await prisma.breakoutAssignmentDraft.findFirst({
    where: { assignmentId: assignment.id, classSessionId: sessionId, studentId: input.studentId },
    select: { answerText: true, revision: true, updatedAt: true },
  });
  return { draft: serializeDraftForStudent(draft) };
}

/** The student's own submission versions, newest first. */
export async function listOwnSubmissions(input: { studentId: string; sessionId: string; assignmentId: string }, options: StudentServiceOptions = {}) {
  const { sessionId, assignment } = await requireVisibleAssignment(input.studentId, input.sessionId, input.assignmentId, options);
  const rows = await prisma.breakoutAssignmentSubmission.findMany({
    where: { assignmentId: assignment.id, classSessionId: sessionId, studentId: input.studentId },
    orderBy: { version: "desc" },
    select: SUBMISSION_STUDENT_SELECT,
  });
  return { submissions: rows.map((row) => serializeSubmissionForStudent(row)) };
}

/** One of the student's OWN submission PDFs; anyone else's is 404. */
export async function getOwnSubmissionFile(
  input: { studentId: string; sessionId: string; assignmentId: string; submissionId: string },
  options: StudentServiceOptions = {}
): Promise<BreakoutPdfDownload> {
  const { sessionId, assignment } = await requireVisibleAssignment(input.studentId, input.sessionId, input.assignmentId, options);
  const submissionId = requireRouteId(input.submissionId, "NOT_FOUND");
  const submission = await prisma.breakoutAssignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId: assignment.id, classSessionId: sessionId, studentId: input.studentId },
    select: { fileName: true, filePath: true },
  });
  if (!submission) throw breakoutError("NOT_FOUND");
  if (!submission.filePath) throw breakoutError("FILE_NOT_FOUND");
  const bytes = await readBreakoutFile(submission.filePath, sessionId, options.storageRoot);
  return { bytes, displayName: submission.fileName ?? "submission.pdf", sizeBytes: bytes.byteLength };
}

// ---- Writes ------------------------------------------------------------------

/**
 * Lock-order levels 1-4 for a write on one assignment: session and
 * enrolment, the room (now), the assignment share lock (visible: status 0,
 * PUBLISHED / CLOSED, this room), then the advisory slot.
 */
async function lockWritableAssignment(tx: Tx, studentId: string, sessionId: string, assignmentId: string, options: StudentServiceOptions) {
  const session = await lockEnrolledActiveSession(tx, studentId, sessionId);
  const room = await requireStudentRoom({ sessionId: session.id, studentId }, options.roomResolver ?? defaultStudentRoomResolver);
  const assignment = await lockActivityShared(tx, session, "assignment", assignmentId);
  if (!assignment || assignment.status !== 0 || assignment.state === "DRAFT" || !activityTargetsRoom(assignment, room)) {
    throw notVisible();
  }
  await lockStudentSubmissionSlot(tx, assignment, studentId);
  return { session, assignment };
}

export type SaveDraftInput = { studentId: string; sessionId: string; assignmentId: string; revision: number; answerText: string };

/**
 * Saves the student's draft. `revision` is the one the student last saw (0
 * when there is no draft yet); a different stored revision is 409
 * REVISION_CONFLICT with the current text and revision. CLOSED: 409
 * ASSIGNMENT_CLOSED (the draft is kept).
 */
export async function saveDraftForStudent(input: SaveDraftInput, options: StudentServiceOptions = {}) {
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  if (!Number.isInteger(input.revision) || input.revision < 0) throw breakoutError("VALIDATION_ERROR", "Invalid revision.");
  if (typeof input.answerText !== "string") throw breakoutError("VALIDATION_ERROR", "Invalid answer text.");
  if (input.answerText.length > MAX_ANSWER_TEXT_LENGTH) throw breakoutError("ANSWER_TEXT_TOO_LONG");
  await serverNow();
  const draft = await inBreakoutTransaction(async (tx) => {
    const { session, assignment } = await lockWritableAssignment(tx, input.studentId, input.sessionId, assignmentId, options);
    if (assignment.state === "CLOSED") throw breakoutError("ASSIGNMENT_CLOSED");
    const now = serverNowSync();
    const current = await tx.breakoutAssignmentDraft.findFirst({
      where: { assignmentId: assignment.id, classSessionId: session.id, studentId: input.studentId },
      select: { id: true, answerText: true, revision: true, updatedAt: true },
    });
    const storedRevision = current?.revision ?? 0;
    if (storedRevision !== input.revision) {
      throw breakoutError("REVISION_CONFLICT", undefined, { answerText: current?.answerText ?? "", revision: storedRevision });
    }
    const select = { answerText: true, revision: true, updatedAt: true } as const;
    if (!current) {
      return tx.breakoutAssignmentDraft.create({
        data: {
          id: randomUUID(),
          assignmentId: assignment.id,
          classSessionId: session.id,
          studentId: input.studentId,
          answerText: input.answerText,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        select,
      });
    }
    return tx.breakoutAssignmentDraft.update({
      where: { id: current.id },
      data: { answerText: input.answerText, revision: current.revision + 1, updatedAt: now },
      select,
    });
  });
  return { draft: serializeDraftForStudent(draft) };
}

/**
 * A file part as received, NOT yet checked as a PDF (only its size is
 * checked before the idempotency lookup): a retry carrying anything must
 * still get its original submission back.
 */
export type RawSubmissionFile = { bytes: Uint8Array; fileName: string; mimeType: string };

export type SubmitAssignmentInput = {
  studentId: string;
  sessionId: string;
  assignmentId: string;
  answerText?: string | null;
  file: RawSubmissionFile | null;
  idempotencyKey: string;
};

/**
 * Submits text, a PDF or both as the next version (the previous latest stops
 * being latest).
 *
 * Idempotent: a repeat with the same key returns the original submission
 * (replayed: true) without a new file or version, whatever the repeat's
 * body is (empty, too long, an invalid PDF or different content), and even
 * after the assignment closed or the limit was reached. So only the request
 * itself is checked before the lookup (assignment id, key format, field
 * types, the 25 MiB file limit); the content (text and/or PDF, text length,
 * the PDF bytes and type) only when no submission has that key.
 *
 * Otherwise CLOSED: 409 ASSIGNMENT_CLOSED; 20 versions: 409
 * SUBMISSION_LIMIT_REACHED. Submitted text also becomes the draft text
 * (revision + 1); a PDF-only submission leaves the draft as it is.
 */
export async function submitAssignmentForStudent(input: SubmitAssignmentInput, options: StudentServiceOptions = {}) {
  // Request checks (before the lookup): never content.
  const assignmentId = requireRouteId(input.assignmentId, "ASSIGNMENT_NOT_FOUND");
  if (!isIdempotencyKey(input.idempotencyKey)) throw breakoutError("VALIDATION_ERROR", "A valid idempotency key is required.");
  if (input.answerText !== undefined && input.answerText !== null && typeof input.answerText !== "string") {
    throw breakoutError("VALIDATION_ERROR", "Invalid answer text.");
  }
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
      const { session, assignment } = await lockWritableAssignment(tx, input.studentId, input.sessionId, assignmentId, options);
      const scope = { assignmentId: assignment.id, classSessionId: session.id, studentId: input.studentId };

      // Idempotency, after the advisory lock (a concurrent repeat waits, then
      // finds it). A match is returned as it is: no content check, no file,
      // no version.
      const replay = await tx.breakoutAssignmentSubmission.findFirst({
        where: { ...scope, idempotencyKey: input.idempotencyKey },
        select: SUBMISSION_STUDENT_SELECT,
      });
      if (replay) return { submission: replay, replayed: true };

      // A new submission: now the content.
      const content = checkSubmissionContent({ answerText: input.answerText ?? null, hasFile: input.file !== null });
      if (!content.ok) throw breakoutError(content.code);
      if (input.file) {
        const pdfCheck = validatePdfUpload(input.file.bytes, input.file.mimeType);
        if (!pdfCheck.ok) throw pdfCheckError(pdfCheck.code);
      }

      const existing = await tx.breakoutAssignmentSubmission.findMany({ where: scope, select: { version: true, isLatest: true } });
      const decision = decideSubmission({
        assignmentState: assignment.state,
        replayFound: false,
        existingVersions: existing.map((row) => row.version),
      });
      if (decision.action === "reject") throw breakoutError(decision.code);
      if (decision.action !== "insert") throw new Error("Unexpected submission decision."); // replays returned above
      assertSingleLatest(existing); // the partial unique index is the database backstop

      const now = serverNowSync();
      let file: { fileName: string; filePath: string; fileSize: number } | null = null;
      if (input.file) {
        // Display name only (database metadata); the stored name is server-generated.
        const displayName = sanitizeDisplayName(input.file.fileName);
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
        file = { fileName: displayName, filePath: stored.relativePath, fileSize: stored.sizeBytes };
      }

      await tx.breakoutAssignmentSubmission.updateMany({ where: { ...scope, isLatest: true }, data: { isLatest: false } });
      const submission = await tx.breakoutAssignmentSubmission.create({
        data: {
          id: randomUUID(),
          ...scope,
          version: decision.version,
          isLatest: true,
          answerText: content.answerText,
          fileName: file?.fileName ?? null,
          filePath: file?.filePath ?? null,
          fileSize: file?.fileSize ?? null,
          idempotencyKey: input.idempotencyKey,
          submittedAt: now,
        },
        select: SUBMISSION_STUDENT_SELECT,
      });

      if (content.answerText !== null) {
        const draft = await tx.breakoutAssignmentDraft.findFirst({ where: scope, select: { id: true, revision: true } });
        if (draft) {
          await tx.breakoutAssignmentDraft.update({
            where: { id: draft.id },
            data: { answerText: content.answerText, revision: draft.revision + 1, updatedAt: now },
          });
        } else {
          await tx.breakoutAssignmentDraft.create({
            data: { id: randomUUID(), ...scope, answerText: content.answerText, revision: 1, createdAt: now, updatedAt: now },
          });
        }
      }
      return { submission, replayed: false };
    });
    return {
      submission: serializeSubmissionForStudent(result.submission, { replayed: result.replayed }),
      replayed: result.replayed,
    };
  } catch (error) {
    // A new PDF (if any) is not deleted here (F2): see the header.
    if (written.path) console.error("Breakout submission PDF left for session cleanup after a failed submit.", { sessionId: written.sessionId });
    throw error;
  }
}
