import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { runWithYouTubeDeadline, youtubeTimeouts } from "@/lib/youtube-request";

/**
 * Locks for YouTube Recording / Live operations (table YouTubeOperationLock),
 * shared by every server process through the database. Two scopes:
 *
 * - Lecture lock (key: the lecture ID): start, stop, failed-start cleanup,
 *   privacy change and session cleanup of one lecture.
 * - Teacher lock (key: "teacher:<teacherId>"): what the teacher's ONE
 *   reusable YouTube stream is used for. Taken by Recording / Live starts
 *   (stream creation, "is another lecture using the stream", the Jibri
 *   decision) and by reusable-stream creation. The key column has no foreign
 *   key, so a teacher key needs no schema change.
 *
 * Lock order: the teacher lock is always taken BEFORE a lecture lock, never
 * inside one. Acquisition never waits for a held lock (409 at once; session
 * cleanup retries a few times within its budget, taking only a lecture lock),
 * so two requests can never wait for each other.
 *
 * - Acquire: INSERT the key's row (the primary key makes only one insert
 *   win), or, if a row exists but has EXPIRED, take it over with one
 *   conditional UPDATE (a concurrent taker re-checks the condition and gets
 *   nothing). A held lock is refused with 409 and the teacher retries.
 * - Release: DELETE only the row this holder owns (a holder that ran past its
 *   expiry never removes the next holder's lock).
 * - Expiry: a crashed or hung holder blocks the key for at most
 *   youtubeTimeouts.lockTtlMs.
 * - Deadline: the holder's YouTube requests (lib/youtube-request.ts) must
 *   finish lockSafetyMarginMs before the lock expires (or earlier, with a
 *   `budgetMs`); a request still running then is aborted and no new one
 *   starts. So a holder never waits on YouTube while another request could
 *   take its lock over. (Database work after that is not aborted; it is
 *   short, and the margin covers it. The lock has no fencing token, so a
 *   holder stalled for longer than the margin outside YouTube, e.g. a paused
 *   process, could still overlap the next holder.)
 */

const TEACHER_KEY_PREFIX = "teacher:";

const isUniqueViolation = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "P2002";

/** Acquires the lock; returns when it expires (epoch ms), or null when held. */
async function tryAcquire(key: string, ownerId: string): Promise<number | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + youtubeTimeouts.lockTtlMs);

  try {
    await prisma.youTubeOperationLock.create({
      data: { lectureId: key, ownerId, expiresAt },
    });

    return expiresAt.getTime();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  // Held: take it over only if it has expired (atomic, single statement).
  const takeover = await prisma.youTubeOperationLock.updateMany({
    where: { lectureId: key, expiresAt: { lt: now } },
    data: { ownerId, expiresAt, createdAt: now },
  });

  return takeover.count === 1 ? expiresAt.getTime() : null;
}

async function release(key: string, ownerId: string) {
  try {
    await prisma.youTubeOperationLock.deleteMany({
      where: { lectureId: key, ownerId },
    });
  } catch (error) {
    // The lock then simply expires.
    console.error("Failed to release the YouTube operation lock:", { key, error });
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type LockOptions = {
  /** YouTube requests end within this time from the call (and by the lock's deadline). */
  budgetMs?: number;
  /**
   * When the lock is held: try again after each of these waits, as long as
   * the whole call stays within `budgetMs`. Default: refuse at once.
   */
  acquireRetryDelaysMs?: number[];
};

async function withYouTubeLock<T>(
  key: string,
  busyMessage: string,
  operation: () => Promise<T>,
  options: LockOptions
): Promise<T> {
  const ownerId = randomUUID();
  const startedAt = Date.now();
  let expiresAt = await tryAcquire(key, ownerId);

  for (const delay of options.acquireRetryDelaysMs ?? []) {
    if (expiresAt !== null) break;

    if (options.budgetMs !== undefined && Date.now() + delay - startedAt >= options.budgetMs) break;

    await sleep(delay);
    expiresAt = await tryAcquire(key, ownerId);
  }

  if (expiresAt === null) {
    throw new AppError(busyMessage, 409, "YOUTUBE_OPERATION_IN_PROGRESS");
  }

  // Waiting for the lock counts against the budget.
  const deadline = Math.min(
    expiresAt - youtubeTimeouts.lockSafetyMarginMs,
    options.budgetMs === undefined ? Infinity : startedAt + options.budgetMs
  );

  try {
    return await runWithYouTubeDeadline(deadline, operation);
  } finally {
    await release(key, ownerId);
  }
}

/**
 * Runs `operation` while holding the lecture's lock, or refuses (409). Its
 * YouTube requests end by the lock's deadline, or within `budgetMs` when
 * given (whichever is earlier).
 */
export function withLectureYouTubeLock<T>(
  lectureId: string,
  operation: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  return withYouTubeLock(
    lectureId,
    "Another YouTube recording or live action is already in progress for this lecture. Please try again in a moment.",
    operation,
    options
  );
}

/**
 * Runs `operation` while holding the teacher's stream lock, or refuses (409).
 * Take it BEFORE any lecture lock (see the lock order above).
 */
export function withTeacherYouTubeLock<T>(
  teacherId: string,
  operation: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  return withYouTubeLock(
    TEACHER_KEY_PREFIX + teacherId,
    "Another YouTube recording or live action is already in progress for your channel. Please try again in a moment.",
    operation,
    options
  );
}
