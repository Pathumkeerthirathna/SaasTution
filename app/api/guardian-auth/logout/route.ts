import { apiSuccess } from "@/lib/api-response";
import {
  buildGuardianSessionCookieConfig,
  GUARDIAN_AUTH_COOKIE_NAME,
} from "@/lib/guardian-auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = apiSuccess(
    { loggedOut: true },
    { message: "Signed out." }
  );

  response.cookies.set(GUARDIAN_AUTH_COOKIE_NAME, "", {
    ...buildGuardianSessionCookieConfig(),
    maxAge: 0,
  });

  return response;
}
