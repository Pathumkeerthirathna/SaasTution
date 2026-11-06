// Shared helpers of the student breakout activity routes
// (/api/sessions/[id]/breakout-activities/me/...). The "_shared" folder is
// private: Next.js never serves it as a route.
//
// Every student route is an exported `async function METHOD(request, context)`
// whose try block starts with requireBreakoutStudent() and whose catch block
// is `return handleRouteError(error, { request })` (the project convention,
// checked by tests/error-logging/review-fixes.test.cjs). In that order:
//   1. the feature flag: off -> 404 NOT_FOUND, before anything else (an
//      unauthenticated caller learns nothing either);
//   2. the student from the signed login cookie (requireStudentSession, the
//      existing convention): none or not a student -> 401;
//   3. request validation, then the student service, which checks the
//      active session, the enrolment, the CURRENT room (the default resolver
//      fails closed: 404 until Phase 2b) and the activity's visibility.
// A student id, a room id or a stored path is never taken from the request:
// the student id passed to services is always the one from the login
// session, and rooms come only from the room resolver.

import { requireStudentSession } from "@/lib/auth-session";
import { assertBreakoutActivitiesEnabled } from "@/lib/breakout-activities/flag";

// The generic request / response helpers are the same as for the teacher routes.
export { mediaType, parseWith, pdfResponse } from "../../_shared/teacher-route";

/** Steps 1 and 2: the feature flag, then the logged-in student's id. */
export async function requireBreakoutStudent(): Promise<string> {
  assertBreakoutActivitiesEnabled();
  const student = await requireStudentSession();
  return student.studentId;
}
