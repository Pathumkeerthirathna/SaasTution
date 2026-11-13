/**
 * Student Profile SP-5.6: the shared "Change your password" form
 * (components/account/password-change-form.tsx) used by /account/security.
 * Markup renders with react-dom/server; the client checks, the response
 * mapping and the request run as plain functions over a fake fetch.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PASSWORD_CHANGE_ENDPOINT,
  PasswordChangeForm,
  checkPasswordChangeForm,
  mapPasswordChangeResponse,
  passwordBackLink,
  submitPasswordChange,
  type AccountRole,
  type PasswordFields,
} from "../../components/account/password-change-form";
import { studentPasswordChangeSchema } from "../../lib/student-password-validation";

const ROOT = path.join(__dirname, "..", "..");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const fields = (patch: Partial<PasswordFields> = {}): PasswordFields => ({ currentPassword: "old-password-1", newPassword: "brand-new-pass", confirmPassword: "brand-new-pass", ...patch });

test("navigation is role-aware: student -> settings, teacher -> dashboard, admin -> admin dashboard", () => {
  assert.deepEqual(passwordBackLink("STUDENT"), { href: "/student/settings", label: "Back to settings" });
  assert.deepEqual(passwordBackLink("TEACHER"), { href: "/dashboard", label: "Back to dashboard" });
  assert.deepEqual(passwordBackLink("ADMIN"), { href: "/dashboard/admin", label: "Back to dashboard" });
  for (const [role, href, label] of [["STUDENT", "/student/settings", "Back to settings"], ["TEACHER", "/dashboard", "Back to dashboard"], ["ADMIN", "/dashboard/admin", "Back to dashboard"]] as const) {
    const html = renderToStaticMarkup(<PasswordChangeForm role={role} />);
    assert.match(html, new RegExp(`<a[^>]*href="${href}"[^>]*>${label}</a>`), role);
  }
});

test("form: current / new / confirm fields for every role, labelled, with autocomplete and maxLength", () => {
  for (const role of ["STUDENT", "TEACHER", "ADMIN"] as AccountRole[]) {
    const html = renderToStaticMarkup(<PasswordChangeForm role={role} />);
    assert.equal((html.match(/<input/g) ?? []).length, 3, role);
    for (const [id, label, autocomplete, max] of [
      ["currentPassword", "Current password", "current-password", 256],
      ["newPassword", "New password", "new-password", 64],
      ["confirmPassword", "Confirm new password", "new-password", 64],
    ] as const) {
      assert.match(html, new RegExp(`<label for="${id}"[^>]*>${label}</label>`));
      assert.match(html, new RegExp(`<input id="${id}" name="${id}" type="password" required="" autoComplete="${autocomplete}" maxLength="${max}"`));
    }
    assert.match(html, /<form[^>]*novalidate=""/i);
    assert.match(html, /<button type="submit"[^>]*>Update password<\/button>/);
    assert.ok(text(html).includes("8–64 characters."));
    assert.doesNotMatch(html, /role="alert"/, "no errors before submitting");
  }
});

test("client checks: students get exactly the server's rules; teachers keep length + the new confirmation only", () => {
  assert.deepEqual(checkPasswordChangeForm(fields(), "STUDENT"), {});
  assert.deepEqual(checkPasswordChangeForm(fields({ confirmPassword: "x" }), "STUDENT"), { confirmPassword: "Passwords do not match." });
  assert.deepEqual(checkPasswordChangeForm(fields({ newPassword: "a".repeat(7), confirmPassword: "a".repeat(7) }), "STUDENT"), { newPassword: "Password must be at least 8 characters long." });
  assert.deepEqual(checkPasswordChangeForm(fields({ newPassword: "a".repeat(65), confirmPassword: "a".repeat(65) }), "STUDENT"), { newPassword: "Password must be at most 64 characters long." });
  assert.deepEqual(checkPasswordChangeForm(fields({ newPassword: "අ".repeat(25), confirmPassword: "අ".repeat(25) }), "STUDENT"), { newPassword: "Password is too long. Use fewer special or non-English characters." });
  assert.deepEqual(checkPasswordChangeForm(fields({ newPassword: "old-password-1", confirmPassword: "old-password-1" }), "STUDENT"), { newPassword: "Your new password must be different from your current password." });
  assert.deepEqual(checkPasswordChangeForm({ currentPassword: "", newPassword: "", confirmPassword: "" }, "STUDENT"), {
    currentPassword: "Enter your current password.",
    newPassword: "Enter a new password.",
    confirmPassword: "Confirm your new password.",
  });

  // Teachers: the 72-byte and same-password rules are not theirs (the server does not apply them).
  assert.deepEqual(checkPasswordChangeForm(fields({ newPassword: "අ".repeat(25), confirmPassword: "අ".repeat(25) }), "TEACHER"), {});
  assert.deepEqual(checkPasswordChangeForm(fields({ newPassword: "old-password-1", confirmPassword: "old-password-1" }), "TEACHER"), {});
  assert.deepEqual(checkPasswordChangeForm(fields({ confirmPassword: "x" }), "TEACHER"), { confirmPassword: "Passwords do not match." });
});

test("client checks agree with the server schema for students (accept / refuse)", () => {
  const samples: PasswordFields[] = [
    fields(),
    fields({ confirmPassword: "different-1" }),
    fields({ newPassword: "a".repeat(7), confirmPassword: "a".repeat(7) }),
    fields({ newPassword: "a".repeat(8), confirmPassword: "a".repeat(8) }),
    fields({ newPassword: "a".repeat(64), confirmPassword: "a".repeat(64) }),
    fields({ newPassword: "a".repeat(65), confirmPassword: "a".repeat(65) }),
    fields({ newPassword: "අ".repeat(24), confirmPassword: "අ".repeat(24) }),
    fields({ newPassword: "අ".repeat(25), confirmPassword: "අ".repeat(25) }),
    fields({ newPassword: "old-password-1", confirmPassword: "old-password-1" }),
    fields({ currentPassword: "" }),
    fields({ currentPassword: "x".repeat(257) }),
    fields({ currentPassword: "x".repeat(256) }),
  ];
  for (const sample of samples) {
    const client = Object.keys(checkPasswordChangeForm(sample, "STUDENT")).length === 0;
    assert.equal(client, studentPasswordChangeSchema.safeParse(sample).success, JSON.stringify(sample).slice(0, 90));
  }
});

test("responses: success (student / teacher / reauthenticate), 401, 403 (inactive / cross-origin / admin), 409, 429, wrong password, validation, other", () => {
  assert.deepEqual(mapPasswordChangeResponse(200, { success: true, data: { updated: true } }, null, "STUDENT"), { ok: true, message: "Your password was changed. You have been signed out on your other devices.", reauthenticate: false });
  assert.deepEqual(mapPasswordChangeResponse(200, { success: true, data: { updated: true } }, null, "TEACHER"), { ok: true, message: "Password updated successfully.", reauthenticate: false });
  assert.deepEqual(mapPasswordChangeResponse(200, { success: true, data: { updated: true, reauthenticate: true } }, null, "STUDENT"), { ok: true, message: "Your password was changed. Please sign in again.", reauthenticate: true });

  const err = (code: string, message = "server text", details?: unknown) => ({ success: false, error: { code, message, details } });
  assert.deepEqual(mapPasswordChangeResponse(401, err("UNAUTHORIZED"), null, "STUDENT"), { ok: false, message: "Your session has expired. Please sign in again.", field: null, signIn: true });
  assert.equal(mapPasswordChangeResponse(403, err("STUDENT_ACCOUNT_INACTIVE"), null, "STUDENT").message, "Your student account is inactive. Please contact your teacher.");
  assert.equal(mapPasswordChangeResponse(403, err("CROSS_ORIGIN_REQUEST_REJECTED"), null, "STUDENT").message, "This request was blocked for security. Reload the page and try again.");
  assert.equal(mapPasswordChangeResponse(403, err("FORBIDDEN", "Admin password cannot be changed from this endpoint."), null, "ADMIN").message, "This account's password can't be changed here.");
  assert.equal(mapPasswordChangeResponse(409, err("PASSWORD_CHANGE_CONFLICT"), null, "STUDENT").message, "Your password could not be changed. Please try again.");
  assert.equal(mapPasswordChangeResponse(429, err("PASSWORD_CHANGE_RATE_LIMITED"), "600", "STUDENT").message, "Too many attempts. Please wait 10 minutes and try again.");
  assert.equal(mapPasswordChangeResponse(429, err("PASSWORD_CHANGE_RATE_LIMITED"), "30", "STUDENT").message, "Too many attempts. Please wait 1 minute and try again.");
  assert.equal(mapPasswordChangeResponse(429, err("PASSWORD_CHANGE_RATE_LIMITED"), null, "STUDENT").message, "Too many attempts. Please wait a few minutes and try again.");
  assert.deepEqual(mapPasswordChangeResponse(400, err("INVALID_CURRENT_PASSWORD"), null, "STUDENT"), { ok: false, message: "Current password is incorrect.", field: "currentPassword", signIn: false });
  assert.deepEqual(mapPasswordChangeResponse(400, err("VALIDATION_ERROR", "Passwords do not match.", { field: "confirmPassword" }), null, "STUDENT"), { ok: false, message: "Passwords do not match.", field: "confirmPassword", signIn: false });
  assert.deepEqual(mapPasswordChangeResponse(400, err("VALIDATION_ERROR", "Password must be at least 8 characters long.", { fieldErrors: {} }), null, "TEACHER"), { ok: false, message: "Password must be at least 8 characters long.", field: null, signIn: false });
  assert.deepEqual(mapPasswordChangeResponse(500, err("INTERNAL_SERVER_ERROR"), null, "STUDENT"), { ok: false, message: "Failed to update password.", field: null, signIn: false });
  assert.equal(mapPasswordChangeResponse(502, null, null, "STUDENT").message, "Failed to update password.");
});

test("submit: POSTs exactly the three fields, same-origin, no-store; never throws (network error)", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const outcome = await submitPasswordChange(fields(), "STUDENT", async (url, init) => {
    calls.push({ url, init });
    return json(429, { success: false, error: { code: "PASSWORD_CHANGE_RATE_LIMITED", message: "x" } }, { "Retry-After": "120" });
  });
  assert.equal(PASSWORD_CHANGE_ENDPOINT, "/api/auth/password/update");
  assert.equal(calls[0].url, "/api/auth/password/update");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { currentPassword: "old-password-1", newPassword: "brand-new-pass", confirmPassword: "brand-new-pass" });
  assert.equal(outcome.message, "Too many attempts. Please wait 2 minutes and try again.");

  const offline = await submitPasswordChange(fields(), "TEACHER", async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(offline, { ok: false, message: "Unable to update password right now.", field: null, signIn: false });
});

test("reauthenticate: the server's response turns on the Sign in action (to /login), never the normal success message", async () => {
  // Exactly what lib/student-password-change-http.ts answers when signing fails after the commit.
  const outcome = await submitPasswordChange(fields(), "STUDENT", async () =>
    json(200, { success: true, message: "Your password was changed. Please sign in again.", data: { updated: true, reauthenticate: true } })
  );
  assert.deepEqual(outcome, { ok: true, message: "Your password was changed. Please sign in again.", reauthenticate: true });
  assert.ok(outcome.ok && !outcome.message.includes("signed out on your other devices"), "not the normal success text");
  const normal = mapPasswordChangeResponse(200, { success: true, data: { updated: true } }, null, "STUDENT");
  assert.ok(normal.ok && normal.reauthenticate === false && normal.message.includes("signed out on your other devices"), "the normal state, for contrast");

  // The form: a successful outcome clears the fields and shows its message with Sign in = outcome.reauthenticate ...
  const form = readFileSync(path.join(ROOT, "components", "account", "password-change-form.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(form, /if \(outcome\.ok\) \{\s*setValues\(EMPTY\);\s*setErrors\(\{\}\);\s*setMessage\(outcome\.message\);\s*setSignIn\(outcome\.reauthenticate\);\s*return;\s*\}/);
  // ... and that message block renders the Sign in link to /login whenever signIn is on.
  const statusBlock = form.slice(form.indexOf("{message ? ("), form.indexOf("<button", form.indexOf("{message ? (")));
  assert.match(statusBlock, /<p role="status"[^>]*>\s*\{message\}\s*\{signIn \? \(\s*<>\s*\{" "\}\s*<Link href="\/login"[^>]*>\s*Sign in\s*<\/Link>\s*<\/>\s*\) : null\}\s*<\/p>/);
  assert.equal((statusBlock.match(/<Link /g) ?? []).length, 1, "the only link in the status message is Sign in");
});

test("form wiring: duplicate submissions blocked, fields cleared on success, field errors announced, page checks students centrally", () => {
  const form = readFileSync(path.join(ROOT, "components", "account", "password-change-form.tsx"), "utf8");
  assert.match(form, /if \(inFlight\.current\) return;/);
  assert.match(form, /disabled=\{isSubmitting\}/);
  assert.match(form, /setValues\(EMPTY\);/);
  assert.match(form, /aria-invalid=\{error \? true : undefined\}/);
  assert.match(form, /aria-describedby=\{error \? `\$\{name\}-error` : undefined\}/);
  const page = readFileSync(path.join(ROOT, "app", "account", "security", "page.tsx"), "utf8");
  assert.match(page, /checkStudentSessionAccess\(session\)\) !== "ACTIVE"/);
  assert.match(page, /<PasswordChangeForm role=\{session\.role\} \/>/);
  assert.doesNotMatch(page, /"use client"/);
});
