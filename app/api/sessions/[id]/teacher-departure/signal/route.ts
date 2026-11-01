import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { isMobileRequest } from "@/lib/browser-form-factor";
import {
  isValidPageId,
  recordTeacherActivity,
  recordTeacherDepartureSignal,
  recordTeacherResumeSignal,
  registerTeacherPage,
} from "@/lib/teacher-presence";
import { ensureSessionAccessForTeacher } from "@/services/session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * The teacher's classroom page reports its lifecycle
 * (components/Jitsi/teacher-departure-signal.ts; lib/teacher-presence.ts has
 * the rules), with a text/plain JSON body and the login cookie:
 *
 * - { kind: "register", pageId }: the page loaded (once per page): it
 *   becomes the current page; a refresh cancels the old page's signal.
 * - { kind: "heartbeat", pageId }: every 10 s while the page lives: another
 *   open tab cancels the current page's pending signal.
 * - { kind: "closing", pageId }: pagehide, not persisted, desktop browsers
 *   only (sendBeacon). Accepted only from the current page, and recorded as a
 *   PENDING departure: nothing stops until it is confirmed (no teacher
 *   activity within the 15 s reload-confirmation window). A mobile browser's
 *   signal is ignored here too (Sec-CH-UA-Mobile / User-Agent).
 * - { kind: "resume", pageId }: pageshow, persisted (back from the
 *   back/forward cache): withdraws that page's pending signal.
 *
 * Only the class's own teacher (students and other users: 401, another
 * teacher: 404), only from this site's own pages (403), only for an active
 * session (409). Duplicate and stale signals change nothing.
 */

const KINDS = ["register", "heartbeat", "closing", "resume"] as const;

type SignalKind = (typeof KINDS)[number];

/** The request comes from a page of this site (beacons send Origin). */
function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");

  if (!origin) {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }

  let originHost: string;

  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;

  return originHost === host;
}

async function readSignal(request: Request): Promise<{ kind: SignalKind; pageId: string }> {
  let body: unknown;

  try {
    body = JSON.parse(await request.text());
  } catch {
    throw new AppError("Invalid JSON body.", 400, "VALIDATION_ERROR");
  }

  const { kind, pageId } = (body ?? {}) as { kind?: unknown; pageId?: unknown };

  if (!KINDS.includes(kind as SignalKind) || !isValidPageId(pageId)) {
    throw new AppError("A signal needs a kind (register / heartbeat / closing / resume) and a valid pageId.", 400, "VALIDATION_ERROR");
  }

  return { kind: kind as SignalKind, pageId };
}

export async function POST(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const sessionId = context.params.id?.trim();

    if (!sessionId) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    if (!isSameOrigin(request)) {
      throw new AppError("Cross-site request refused.", 403, "FORBIDDEN");
    }

    const teacherSession = await requireTeacherSession();

    // The class's own teacher only (404 otherwise, as everywhere for sessions).
    await ensureSessionAccessForTeacher(teacherSession.teacherId, sessionId);

    const { kind, pageId } = await readSignal(request);

    if (kind === "register") {
      const registered = await registerTeacherPage(sessionId, pageId);

      if (!registered.registered) {
        throw new AppError("This class session is no longer active.", 409, "SESSION_NOT_ACTIVE");
      }

      return apiSuccess(registered);
    }

    if (kind === "heartbeat") {
      return apiSuccess({ cancelledDeparture: await recordTeacherActivity(sessionId, pageId) });
    }

    if (kind === "resume") {
      return apiSuccess(await recordTeacherResumeSignal(sessionId, pageId));
    }

    // Closing signals are for desktop browsers only (the page does not send
    // them on mobile; this refuses one that comes anyway).
    if (isMobileRequest(request.headers)) {
      return apiSuccess({ accepted: false, reason: "mobile-browser" });
    }

    const result = await recordTeacherDepartureSignal(sessionId, pageId);

    if (!result.accepted && result.reason === "session-not-active") {
      throw new AppError("This class session is no longer active.", 409, "SESSION_NOT_ACTIVE");
    }

    return apiSuccess(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
