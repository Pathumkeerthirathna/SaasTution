import { handlePasswordResetRequest } from "@/lib/password-reset-request-http";

// Student Profile SP-7C: origin, body, rate limits and the generic answer
// live in lib/password-reset-request-http.ts.
export async function POST(request: Request) {
  return handlePasswordResetRequest(request, { appBaseUrl: process.env.NEXT_PUBLIC_APP_URL });
}
