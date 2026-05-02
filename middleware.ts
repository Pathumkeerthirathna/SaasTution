import { NextRequest, NextResponse } from "next/server";

import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";

const PROTECTED_ROUTES = [
  "/dashboard",
  "/api/admin",
  "/api/auth/me",
  "/api/classes",
  "/api/students",
  "/api/guardians",
  "/api/messages",
  "/api/lectures",
];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtectedPath = PROTECTED_ROUTES.some((route) => path.startsWith(route));

  if (!isProtectedPath) {
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Authentication required.",
            code: "UNAUTHORIZED",
          },
        },
        { status: 401 }
      );
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", path);
    return NextResponse.redirect(loginUrl);
  }

  const payload = await verifyAuthToken(token);

  if (!payload) {
    if (path.startsWith("/api/")) {
      const response = NextResponse.json(
        {
          success: false,
          error: {
            message: "Session is invalid or expired.",
            code: "UNAUTHORIZED",
          },
        },
        { status: 401 }
      );
      response.cookies.delete(AUTH_COOKIE_NAME);
      return response;
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", path);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete(AUTH_COOKIE_NAME);
    return response;
  }

  if (path.startsWith("/api/admin") && payload.role !== "ADMIN") {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: "Admin privileges are required.",
          code: "FORBIDDEN",
        },
      },
      { status: 403 }
    );
  }

  if (path.startsWith("/dashboard/admin") && payload.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (path === "/dashboard" && payload.role === "ADMIN") {
    return NextResponse.redirect(new URL("/dashboard/admin", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/admin/:path*",
    "/api/auth/me",
    "/api/classes/:path*",
    "/api/students/:path*",
    "/api/guardians/:path*",
    "/api/messages/:path*",
    "/api/lectures/:path*",
  ],
};
