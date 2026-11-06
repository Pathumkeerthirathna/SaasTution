// Breakout Group Activities at End Session: the teacher keeps (preserve) or
// deletes (delete) the session's GROUP activities. INDIVIDUAL activities,
// their drafts, submissions, quiz attempts and files are never read for
// deletion and never changed here.
//
// Safety-critical: called by services/session-service.ts while ending a
// session, so it must NEVER import the breakout feature flag (guarded by
// tests/breakout-activities/flag-guard.test.cjs). GROUP data created while the
// flag was on is offered for the decision whatever the flag says.
//
// Delete, in three steps (files are never deleted before the decision is
// committed, and rows are never deleted before their files are gone):
//   1. endSessionAndMarkGroupActivitiesForPurge(): ONE breakout transaction
//      that takes the session row FOR UPDATE (lockSessionExclusive: waits for
//      every running breakout write, which hold FOR KEY SHARE; later writes see
//      the session ended), ends the session, deletes the session's group
//      memberships and marks the GROUP activities status = 2 ("purge
//      pending"). Every existing read filters status 0, so they disappear at
//      once. The decision only applies in the transaction that actually ends
//      the session: an already-ended session is never changed.
//   2. purgeGroupActivities(): removes the activity folders of the marked
//      rows (briefs/<id>, briefs/<publishGroupId>, submissions/<id>) after
//      validating every stored path against this session's folder and
//      skipping any folder that a retained row (any INDIVIDUAL activity or
//      submission, any GROUP activity not marked) refers to.
//   3. Only when every folder is gone: one transaction hard-deletes the
//      marked rows (classSessionId + workMode GROUP + status 2 + their ids);
//      the database cascades their group work / attempt rows.
// A failure in 2 or 3 leaves the rows marked (status 2): cleanup is
// "pending" and the next purge retries it (idempotent; concurrent purges
// are harmless: removing a missing folder and deleting deleted rows change
// nothing). Retried by a repeated End Session that asks for delete and by
// scripts/breakout-group-purge.ts.

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { lockSessionExclusive } from "@/lib/breakout-activities/locks";
import { resolveBreakoutFilePath, type BreakoutFileKind } from "@/lib/breakout-activities/pdf-file";
import { breakoutStorageRoot, removeBreakoutActivityDir } from "@/lib/breakout-activities/storage";
import { groupError } from "@/lib/breakout-activities/groups/errors";

import { inBreakoutTransaction } from "./breakout-assignment-service";

export type GroupSessionEndDecision = "preserve" | "delete";

/** status of a GROUP activity row marked for deletion at session end (0 = active, 1 = soft-deleted draft). */
export const GROUP_PURGE_PENDING_STATUS = 2;

/** GROUP rows of one session that the decision covers: active and soft-deleted (status 0 / 1). */
function liveGroupWhere(sessionId: string) {
  return { classSessionId: sessionId, workMode: "GROUP" as const, status: { in: [0, 1] } };
}

/** GROUP rows of one session marked for deletion (status 2). */
function pendingGroupWhere(sessionId: string) {
  return { classSessionId: sessionId, workMode: "GROUP" as const, status: GROUP_PURGE_PENDING_STATUS };
}

export function isGroupSessionEndDecision(value: unknown): value is GroupSessionEndDecision {
  return value === "preserve" || value === "delete";
}

// ---- 0. Is a decision needed? -------------------------------------------------------

export type GroupSessionEndSummary = {
  assignments: number;
  quizzes: number;
  rooms: number;
  submittedAssignments: number;
  submittedQuizzes: number;
};

/**
 * What the teacher decides about, or null when the session has no GROUP
 * activity (then End Session needs no decision and runs as before).
 * Membership alone (confirmed groups, no activity) needs no decision.
 */
export async function summarizeGroupActivitiesForSessionEnd(sessionId: string): Promise<GroupSessionEndSummary | null> {
  const where = liveGroupWhere(sessionId);
  const [assignments, quizzes] = await Promise.all([prisma.breakoutAssignment.count({ where }), prisma.breakoutQuiz.count({ where })]);
  if (assignments + quizzes === 0) return null;

  const [assignmentRows, quizRows] = await Promise.all([
    prisma.breakoutAssignment.findMany({ where, select: { id: true, targetRoomId: true } }),
    prisma.breakoutQuiz.findMany({ where, select: { id: true, targetRoomId: true } }),
  ]);
  const [submittedAssignments, submittedQuizzes] = await Promise.all([
    assignmentRows.length
      ? prisma.breakoutGroupAssignmentWork.count({
          where: { classSessionId: sessionId, assignmentId: { in: assignmentRows.map((row) => row.id) }, submittedAt: { not: null } },
        })
      : 0,
    quizRows.length
      ? prisma.breakoutGroupQuizAttempt.count({
          where: { classSessionId: sessionId, quizId: { in: quizRows.map((row) => row.id) }, attemptStatus: { in: ["SUBMITTED", "AUTO_SUBMITTED"] } },
        })
      : 0,
  ]);
  const rooms = new Set([...assignmentRows, ...quizRows].map((row) => row.targetRoomId).filter((id): id is string => Boolean(id))).size;
  return { assignments, quizzes, rooms, submittedAssignments, submittedQuizzes };
}

/** 409 GROUP_ACTIVITIES_DECISION_REQUIRED (with the summary) when GROUP activities exist and no decision was given. */
export function requireGroupSessionEndDecision(summary: GroupSessionEndSummary | null, decision: GroupSessionEndDecision | undefined): GroupSessionEndDecision | null {
  if (!summary) return null;
  if (!decision) throw groupError("GROUP_ACTIVITIES_DECISION_REQUIRED", undefined, { summary });
  return decision;
}

// ---- 1. End the session and mark the GROUP activities -------------------------------

/**
 * The Delete choice's End Session (see the header, step 1). Returns
 * ended: false (and changes nothing) when the session had already ended:
 * a late or duplicate request never deletes anything.
 */
export async function endSessionAndMarkGroupActivitiesForPurge(input: { teacherId: string; sessionId: string; endedAt: Date }) {
  await serverNow();
  return inBreakoutTransaction(async (tx) => {
    const session = await lockSessionExclusive(tx, input.sessionId);
    if (!session) throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
    const owned = await tx.class.findFirst({ where: { id: session.classId, teacherId: input.teacherId }, select: { id: true } });
    if (!owned) throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
    if (!session.isActive) return { ended: false as const, assignments: 0, quizzes: 0 };

    // The same change as the existing End Session (isActive / endedAt), under the lock.
    const { count } = await tx.classSession.updateMany({ where: { id: session.id, isActive: true }, data: { isActive: false, endedAt: input.endedAt } });
    if (count !== 1) return { ended: false as const, assignments: 0, quizzes: 0 };

    const now = serverNowSync();
    // Group memberships belong to Group Activities only; they hold no files.
    await tx.breakoutRoomMember.deleteMany({ where: { classSessionId: session.id } });
    const marked = { status: GROUP_PURGE_PENDING_STATUS, updatedAt: now };
    const assignments = await tx.breakoutAssignment.updateMany({ where: liveGroupWhere(session.id), data: marked });
    const quizzes = await tx.breakoutQuiz.updateMany({ where: liveGroupWhere(session.id), data: marked });
    return { ended: true as const, assignments: assignments.count, quizzes: quizzes.count };
  });
}

// ---- 2 + 3. Purge: files first, then rows ---------------------------------------------

export type GroupPurgeResult = {
  /** none: nothing marked; done: files and rows removed; pending: kept marked, retry later. */
  status: "none" | "done" | "pending";
  assignments: number;
  quizzes: number;
};

type Folder = { kind: BreakoutFileKind; id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const folderKey = (folder: Folder) => `${folder.kind}:${folder.id.toLowerCase()}`;

/** The activity folder of a stored path, or null when the path is not a valid file of THIS session. */
function folderOfStoredPath(storageRoot: string, relativePath: string, sessionId: string): Folder | null {
  try {
    resolveBreakoutFilePath(storageRoot, relativePath, sessionId);
  } catch {
    return null;
  }
  const parts = relativePath.split("/");
  return { kind: parts[2] === "briefs" ? "brief" : "submission", id: parts[3].toLowerCase() };
}

/** The folders an assignment row may own: briefs/<id>, submissions/<id>, briefs/<publishGroupId>. */
function foldersOfAssignment(row: { id: string; publishGroupId: string | null }): Folder[] {
  const out: Folder[] = [
    { kind: "brief", id: row.id },
    { kind: "submission", id: row.id },
  ];
  if (row.publishGroupId && UUID.test(row.publishGroupId)) out.push({ kind: "brief", id: row.publishGroupId });
  return out;
}

/**
 * Steps 2 and 3 for one ENDED session (an active session is never purged).
 * Never throws for a file problem: it reports "pending" and keeps the rows.
 */
export type GroupPurgeOptions = {
  /** Storage root override (tests); default <cwd>/storage. */
  storageRoot?: string;
  /** Folder removal override (tests: a failing removal); default removeBreakoutActivityDir. */
  removeActivityDir?: typeof removeBreakoutActivityDir;
};

export async function purgeGroupActivities(sessionId: string, options: GroupPurgeOptions = {}): Promise<GroupPurgeResult> {
  const none: GroupPurgeResult = { status: "none", assignments: 0, quizzes: 0 };
  const storageRoot = options.storageRoot ?? breakoutStorageRoot();
  const session = await prisma.classSession.findUnique({ where: { id: sessionId }, select: { id: true, isActive: true } });
  if (!session || session.isActive) return none;

  const [assignments, quizzes] = await Promise.all([
    prisma.breakoutAssignment.findMany({ where: pendingGroupWhere(session.id), select: { id: true, publishGroupId: true, briefFilePath: true } }),
    prisma.breakoutQuiz.findMany({ where: pendingGroupWhere(session.id), select: { id: true } }),
  ]);
  if (assignments.length === 0 && quizzes.length === 0) return none;

  const purgeIds = new Set(assignments.map((row) => row.id));
  const [allAssignments, allWorks, individualSubmissions] = await Promise.all([
    prisma.breakoutAssignment.findMany({ where: { classSessionId: session.id }, select: { id: true, publishGroupId: true, briefFilePath: true } }),
    prisma.breakoutGroupAssignmentWork.findMany({ where: { classSessionId: session.id }, select: { assignmentId: true, filePath: true } }),
    // Read only, to protect their folders: individual submissions are never changed here.
    prisma.breakoutAssignmentSubmission.findMany({ where: { classSessionId: session.id }, select: { filePath: true } }),
  ]);

  // Folders the marked rows own or refer to. A stored path that is not a
  // valid file of this session is never touched, and keeps the rows (pending).
  let refused = false;
  const candidates = new Map<string, Folder>();
  const add = (folder: Folder) => candidates.set(folderKey(folder), folder);
  const addPath = (filePath: string | null) => {
    if (!filePath) return;
    const folder = folderOfStoredPath(storageRoot, filePath, session.id);
    if (folder) add(folder);
    else refused = true;
  };
  for (const row of assignments) {
    foldersOfAssignment(row).forEach(add);
    addPath(row.briefFilePath);
  }
  for (const work of allWorks) if (purgeIds.has(work.assignmentId)) addPath(work.filePath);

  // Folders that something retained may own or refer to: never removed.
  const retained = new Set<string>();
  const protectPath = (filePath: string | null) => {
    const folder = filePath ? folderOfStoredPath(storageRoot, filePath, session.id) : null;
    if (folder) retained.add(folderKey(folder));
  };
  for (const row of allAssignments) {
    if (purgeIds.has(row.id)) continue;
    foldersOfAssignment(row).forEach((folder) => retained.add(folderKey(folder)));
    protectPath(row.briefFilePath);
  }
  for (const work of allWorks) if (!purgeIds.has(work.assignmentId)) protectPath(work.filePath);
  for (const submission of individualSubmissions) protectPath(submission.filePath);

  let failed = false;
  for (const [key, folder] of candidates) {
    if (retained.has(key)) continue;
    const { removed } = await (options.removeActivityDir ?? removeBreakoutActivityDir)(session.id, folder.kind, folder.id, storageRoot);
    if (!removed) failed = true;
  }

  const counts = { assignments: assignments.length, quizzes: quizzes.length };
  if (refused) console.error("Breakout group purge kept rows: a stored file path is not inside this session's folder.", { sessionId: session.id });
  if (refused || failed) return { status: "pending", ...counts };

  // Every folder is gone: now the rows (their group work / attempts cascade).
  await inBreakoutTransaction(async (tx) => {
    await tx.breakoutAssignment.deleteMany({ where: { ...pendingGroupWhere(session.id), id: { in: assignments.map((row) => row.id) } } });
    await tx.breakoutQuiz.deleteMany({ where: { ...pendingGroupWhere(session.id), id: { in: quizzes.map((row) => row.id) } } });
  });
  return { status: "done", ...counts };
}

/** purgeGroupActivities() for the session-end response: any error is reported as pending, never thrown. */
export async function purgeGroupActivitiesSafely(sessionId: string, options: GroupPurgeOptions = {}): Promise<GroupPurgeResult> {
  try {
    return await purgeGroupActivities(sessionId, options);
  } catch (error) {
    console.error("Breakout group purge failed; it stays pending and can be retried.", { sessionId, error });
    return { status: "pending", assignments: 0, quizzes: 0 };
  }
}

/** Ended sessions that still have GROUP activities marked for deletion (the retry script). */
export async function sessionsWithPendingGroupPurge(): Promise<string[]> {
  const [assignments, quizzes] = await Promise.all([
    prisma.breakoutAssignment.findMany({ where: { workMode: "GROUP", status: GROUP_PURGE_PENDING_STATUS }, select: { classSessionId: true } }),
    prisma.breakoutQuiz.findMany({ where: { workMode: "GROUP", status: GROUP_PURGE_PENDING_STATUS }, select: { classSessionId: true } }),
  ]);
  return [...new Set([...assignments, ...quizzes].map((row) => row.classSessionId))].sort();
}
