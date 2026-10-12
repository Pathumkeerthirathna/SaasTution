import { NextResponse } from "next/server";

/**
 * Developer-only diagnostic API routes (e.g. /api/youtube/test-*): off in
 * production builds, where they answer 404 before anything else runs (no
 * login check, no YouTube or database call).
 */
export function debugRouteDisabledResponse() {
  return process.env.NODE_ENV === "production"
    ? NextResponse.json({ success: false, error: "Not found." }, { status: 404 })
    : null;
}
