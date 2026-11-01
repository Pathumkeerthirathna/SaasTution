import { prisma } from "@/lib/prisma";
import { serverNow } from "@/lib/server-clock";
import {
  endYouTubeFeaturesForDepartedTeacher,
  type TeacherDepartureStopResult,
} from "@/lib/youtube-feature-lifecycle";

/*
 * Teacher-departure sweep: ends the YouTube Recording / Live of a class whose
 * teacher closed the classroom tab (a tab-close signal confirmed by its
 * reload window: lib/teacher-presence.ts; endYouTubeFeaturesForDepartedTeacher
 * holds all the rules). Everything it needs is in the database
 * (ClassSession.teacherDepartureAt / teacherActiveAfterDepartureAt, the
 * feature rows), so a restarted process simply picks up where the last one
 * stopped. Overlapping sweeps (two server processes, the interval and a
 * request at once) are safe: each lecture is handled under its YouTube lock,
 * which a second sweeper finds busy and skips.
 *
 * Triggers, because the deployment may be a long-running `next start`
 * process or serverless functions (netlify.toml):
 *
 * - startTeacherDepartureSweeper(): an interval, from instrumentation.ts, only
 *   on a long-running production Node server (not on Netlify / AWS Lambda,
 *   where a frozen function could hold a lecture lock until it expires).
 * - checkLectureForDepartedTeacher(): from a student's live-updates
 *   connection (the students who are still in the class), throttled per
 *   lecture; works wherever requests arrive.
 * - The teacher's return: GET /api/sessions/[id]/teacher-departure processes
 *   a confirmed departure before it reports the notices.
 */

/** How often a sweep runs (and how often a lecture is checked from requests). */
export const TEACHER_DEPARTURE_SWEEP_INTERVAL_MS = 5_000;

/**
 * Lectures whose current class session has a tab-close signal: only these can
 * need a stop, or a YouTube end to attribute to the departure (pending,
 * cancelled and confirmed signals alike; each is checked cheaply).
 */
async function lecturesWithDepartureSignal(): Promise<string[]> {
  const sessions = await prisma.classSession.findMany({
    where: { isActive: true, teacherDepartureAt: { not: null }, lectureId: { not: null } },
    select: { lectureId: true },
  });

  return Array.from(new Set(sessions.map(row => row.lectureId).filter((id): id is string => Boolean(id))));
}

/**
 * One sweep: every lecture whose session has a tab-close signal is checked
 * (cheaply, no lock without a confirmed departure). Never throws.
 */
export async function sweepDepartedTeachers(
  at?: Date
): Promise<{ lectureId: string; result: TeacherDepartureStopResult }[]> {
  const now = at ?? await serverNow();

  let lectureIds: string[];

  try {
    lectureIds = await lecturesWithDepartureSignal();
  } catch (error) {
    console.error("Teacher-departure sweep could not list sessions with a tab-close signal:", error);
    return [];
  }

  const results: { lectureId: string; result: TeacherDepartureStopResult }[] = [];

  // One lecture at a time: each may call YouTube (bounded per lecture).
  for (const lectureId of lectureIds) {
    results.push({ lectureId, result: await endYouTubeFeaturesForDepartedTeacher(lectureId, now) });
  }

  return results;
}

// Per process: one interval, and sweeps never overlap within it.
const sweeperState = globalThis as unknown as {
  slTeacherDepartureSweeper?: { timer: ReturnType<typeof setInterval>; running: boolean };
};

/** Where an in-process interval sweeper may run (see the header). */
export function canRunIntervalSweeper(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME) return false;

  return true;
}

/**
 * Starts this process's interval sweeper (once; later calls do nothing).
 * Returns whether it is running after the call. The timer does not keep
 * the process alive.
 */
export function startTeacherDepartureSweeper(env: NodeJS.ProcessEnv = process.env): boolean {
  if (sweeperState.slTeacherDepartureSweeper) return true;
  if (!canRunIntervalSweeper(env)) return false;

  const state = {
    running: false,
    timer: setInterval(() => {
      if (state.running) return;

      state.running = true;
      sweepDepartedTeachers()
        .catch(error => console.error("Teacher-departure sweep failed:", error))
        .finally(() => {
          state.running = false;
        });
    }, TEACHER_DEPARTURE_SWEEP_INTERVAL_MS),
  };

  state.timer.unref?.();
  sweeperState.slTeacherDepartureSweeper = state;

  console.log("Teacher-departure sweeper started (every " + TEACHER_DEPARTURE_SWEEP_INTERVAL_MS / 1000 + " s).");

  return true;
}

/** Stops this process's interval sweeper (tests, teardown). */
export function stopTeacherDepartureSweeper() {
  const state = sweeperState.slTeacherDepartureSweeper;

  if (state) {
    clearInterval(state.timer);
    delete sweeperState.slTeacherDepartureSweeper;
  }
}

// lectureId -> when this process last checked it from a request.
const lastChecked = new Map<string, number>();

/**
 * Request-driven check of one lecture (a student still connected to the
 * class): at most once per TEACHER_DEPARTURE_SWEEP_INTERVAL_MS per lecture in
 * this process. Returns null when throttled. Never throws.
 */
export async function checkLectureForDepartedTeacher(
  lectureId: string | null | undefined,
  at?: Date
): Promise<TeacherDepartureStopResult | null> {
  const now = at ?? await serverNow();

  if (!lectureId) return null;

  const last = lastChecked.get(lectureId);

  if (last !== undefined && now.getTime() - last < TEACHER_DEPARTURE_SWEEP_INTERVAL_MS) {
    return null;
  }

  lastChecked.set(lectureId, now.getTime());

  // Bounded: lectures are only remembered for one interval.
  for (const [id, at] of lastChecked) {
    if (now.getTime() - at >= TEACHER_DEPARTURE_SWEEP_INTERVAL_MS) lastChecked.delete(id);
  }

  return endYouTubeFeaturesForDepartedTeacher(lectureId, now);
}
