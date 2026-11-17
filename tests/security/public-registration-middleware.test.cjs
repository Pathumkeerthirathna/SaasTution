/*
 * middleware.ts: the ONLY anonymous route under /api/students is the exact
 * public class registration endpoint (POST /api/students/public/Register).
 * Every other student API, case variants and sub-paths of that URL stay
 * protected, and teacher / student / admin authorization is unchanged.
 *
 *   npm run test:security
 *
 * The real middleware, in-process, with real signed tokens (throwaway
 * JWT_SECRET). No server, no database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.JWT_SECRET = "public-registration-middleware-test-secret-0123456789";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { NextRequest } = require("next/server");
const { middleware } = require(path.join(root, "middleware.ts"));
const { signAuthToken, AUTH_COOKIE_NAME } = require(path.join(root, "lib", "auth.ts"));

const APP_ORIGIN = "https://app.example.test";
const PUBLIC_REGISTER = "/api/students/public/Register";

const request = (url, method = "GET", token) =>
  new NextRequest(`${APP_ORIGIN}${url}`, {
    method,
    headers: token ? { cookie: `${AUTH_COOKIE_NAME}=${token}` } : {},
  });

/** NextResponse.next(): the request continues to the route. */
const passesThrough = (response) => response.headers.get("x-middleware-next") === "1";

const tokens = {};
test.before(async () => {
  tokens.teacher = await signAuthToken({ sub: "t1", email: "t@mail.com", name: "Teacher", role: "TEACHER" });
  tokens.student = await signAuthToken({ sub: "s1", email: "s@mail.com", name: "Student", role: "STUDENT", sessionVersion: 0 });
  tokens.admin = await signAuthToken({ sub: "a1", email: "a@mail.com", name: "Admin", role: "ADMIN" });
});

const PROTECTED_STUDENT_APIS = [
  ["GET", "/api/students"],
  ["POST", "/api/students"],
  ["GET", "/api/students/check-email?registrationNumber=a%40b.co"],
  ["GET", "/api/students/check-name?registrationNumber=Nimal"],
  ["POST", "/api/students/import"],
  ["GET", "/api/students/email-deliveries"],
  ["POST", "/api/students/00000000-0000-4000-8000-000000000000/resend-registration-emails"],
];

const NOT_EXEMPT_VARIANTS = [
  "/api/students/public/register",
  "/api/students/public/REGISTER",
  "/api/students/Public/Register",
  "/api/students/public/Register/extra",
  "/api/students/public/Register2",
  "/api/students/public",
  "/api/students/public/",
  "/api/students/public/Other",
];

test("anonymous: POST to the exact public registration URL passes through", async () => {
  assert.ok(passesThrough(await middleware(request(PUBLIC_REGISTER, "POST"))));
});

test("anonymous: every other /api/students endpoint is still 401 UNAUTHORIZED", async () => {
  for (const [method, url] of PROTECTED_STUDENT_APIS) {
    const response = await middleware(request(url, method));
    assert.equal(response.status, 401, url);
    assert.equal((await response.json()).error.code, "UNAUTHORIZED", url);
  }
});

test("anonymous: case variants and sub-paths of the public URL are not exempt", async () => {
  for (const url of NOT_EXEMPT_VARIANTS) {
    const response = await middleware(request(url, "POST"));
    assert.equal(response.status, 401, url);
  }
});

test("an invalid session cookie: still 401 on protected student APIs; the public URL passes", async () => {
  const bad = await middleware(request("/api/students", "GET", "not-a-jwt"));
  assert.equal(bad.status, 401);
  assert.ok(passesThrough(await middleware(request(PUBLIC_REGISTER, "POST", "not-a-jwt"))));
});

test("signed in (teacher, student, admin): the public URL passes for everyone", async () => {
  for (const role of ["teacher", "student", "admin"]) {
    assert.ok(passesThrough(await middleware(request(PUBLIC_REGISTER, "POST", tokens[role]))), role);
  }
});

test("existing authorization is unchanged", async () => {
  // A teacher reaches the student APIs and the dashboard, not admin APIs.
  for (const [method, url] of PROTECTED_STUDENT_APIS) {
    assert.ok(passesThrough(await middleware(request(url, method, tokens.teacher))), url);
  }
  assert.ok(passesThrough(await middleware(request("/dashboard", "GET", tokens.teacher))));
  assert.equal((await middleware(request("/api/admin/teachers", "GET", tokens.teacher))).status, 403);
  assert.equal((await middleware(request("/student/dashboard", "GET", tokens.teacher))).status, 307);

  // A student is sent to the student dashboard, not the teacher one.
  const studentDashboard = await middleware(request("/dashboard", "GET", tokens.student));
  assert.equal(studentDashboard.status, 307);
  assert.equal(new URL(studentDashboard.headers.get("location")).pathname, "/student/dashboard");
  assert.ok(passesThrough(await middleware(request("/student/dashboard", "GET", tokens.student))));
  assert.equal((await middleware(request("/api/admin/teachers", "GET", tokens.student))).status, 403);

  // An admin reaches admin APIs; /dashboard goes to the admin dashboard.
  assert.ok(passesThrough(await middleware(request("/api/admin/teachers", "GET", tokens.admin))));
  const adminDashboard = await middleware(request("/dashboard", "GET", tokens.admin));
  assert.equal(new URL(adminDashboard.headers.get("location")).pathname, "/dashboard/admin");

  // Signed-out page requests are redirected to the login page.
  const page = await middleware(request("/dashboard"));
  assert.equal(page.status, 307);
  assert.equal(new URL(page.headers.get("location")).pathname, "/login");
});
