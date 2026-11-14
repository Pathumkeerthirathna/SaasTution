/*
 * Concurrent playback stream limits (Recorded Lectures RL-4.3).
 *
 * A slot is held by one GET response body that is actually streaming file
 * bytes (200 / 206 with a body). HEAD, 404, 416 and error responses never
 * take one. Two limits, checked and taken together:
 *
 *   per student   MAX_STREAMS_PER_STUDENT   -> 429 STREAM_LIMIT_REACHED
 *   per process   MAX_STREAMS_PER_PROCESS   -> 503 STREAMING_BUSY
 *
 * Both are policy constants, not measured capacity (there are deliberately
 * no environment settings for them); tune after real-browser testing.
 *
 * IN-MEMORY, PER PROCESS. Production runs ONE Next.js process (PM2 fork
 * mode, single instance), so these are the real limits. If production ever
 * runs several processes, each has its own counts: the per-student limit
 * then becomes "per student per process".
 *
 * tryAcquire() is synchronous: both counts are checked and both incremented
 * with no await in between, so it is atomic on the single event loop. The
 * release function is idempotent (a second call does nothing), and a
 * student's entry is deleted when its count returns to 0, so the map never
 * grows with students who are no longer streaming.
 *
 * Pure: no imports, no I/O, no timers.
 */

export const MAX_STREAMS_PER_STUDENT = 4;
export const MAX_STREAMS_PER_PROCESS = 64;

export type StreamSlotDenial = "STUDENT" | "GLOBAL";

export type StreamSlotResult = { ok: true; release: () => void } | { ok: false; reason: StreamSlotDenial };

export class StreamSlots {
  private total = 0;
  private readonly perStudentCounts = new Map<string, number>();

  constructor(
    readonly perStudent: number = MAX_STREAMS_PER_STUDENT,
    readonly perProcess: number = MAX_STREAMS_PER_PROCESS
  ) {
    for (const value of [perStudent, perProcess]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid stream slot limit.");
    }
  }

  /** A slot for this student, or the limit that refused it (the student's own limit is reported first). */
  tryAcquire(studentId: string): StreamSlotResult {
    if (typeof studentId !== "string" || studentId === "") throw new TypeError("A student id is required.");
    const current = this.perStudentCounts.get(studentId) ?? 0;
    if (current >= this.perStudent) return { ok: false, reason: "STUDENT" };
    if (this.total >= this.perProcess) return { ok: false, reason: "GLOBAL" };

    this.perStudentCounts.set(studentId, current + 1);
    this.total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        const remaining = (this.perStudentCounts.get(studentId) ?? 1) - 1;
        if (remaining <= 0) this.perStudentCounts.delete(studentId);
        else this.perStudentCounts.set(studentId, remaining);
      },
    };
  }

  get inUse(): number {
    return this.total;
  }

  studentInUse(studentId: string): number {
    return this.perStudentCounts.get(studentId) ?? 0;
  }

  /** How many students currently hold a slot (map size; for leak checks). */
  get studentsStreaming(): number {
    return this.perStudentCounts.size;
  }
}

const slotState = globalThis as unknown as { slRecordedLectureStreamSlots?: StreamSlots };

/** This process's playback stream slots. */
export function getStreamSlots(): StreamSlots {
  if (!slotState.slRecordedLectureStreamSlots) slotState.slRecordedLectureStreamSlots = new StreamSlots();
  return slotState.slRecordedLectureStreamSlots;
}

/** Tests: start from empty slots (optionally with other limits). */
export function resetStreamSlotsForTests(perStudent?: number, perProcess?: number): StreamSlots {
  slotState.slRecordedLectureStreamSlots = new StreamSlots(perStudent, perProcess);
  return slotState.slRecordedLectureStreamSlots;
}
