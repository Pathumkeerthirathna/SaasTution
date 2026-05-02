import { apiSuccess } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, buildSessionCookieConfig } from "@/lib/auth";

export async function POST() {
  const response = apiSuccess(
    {
      loggedOut: true,
    },
    {
      message: "Logout successful.",
    }
  );

  response.cookies.set(AUTH_COOKIE_NAME, "", {
    ...buildSessionCookieConfig(),
    maxAge: 0,
  });

  return response;
}
