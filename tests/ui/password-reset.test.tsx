/**
 * Student Profile SP-7E: the password-reset pages (/reset-password and
 * /reset-password/confirm), components/password-reset/*.
 *
 *   npm run test:ui
 *
 * There is no DOM here (the project's UI tests render with react-dom/server):
 * markup is checked per state through the exported views, and the logic the
 * pages run in the browser — reading and removing the token, the client
 * checks, the requests and the answer mapping — through the exported
 * functions, with fake location / history / fetch / storage. The container
 * components are checked to call exactly those functions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PASSWORD_RESET_REQUEST_ENDPOINT,
  RESET_LOGIN_ID_MAX_LENGTH,
  RESET_REQUEST_MESSAGES,
  ResetRequestView,
  checkResetRequestInput,
  mapResetRequestResponse,
  submitResetRequest,
} from "../../components/password-reset/reset-request-form";
import {
  PASSWORD_RESET_CONFIRM_ENDPOINT,
  RESET_CONFIRM_MESSAGES,
  ResetConfirmView,
  checkResetPasswordFields,
  mapResetConfirmResponse,
  submitResetConfirm,
  takeResetTokenFromLocation,
} from "../../components/password-reset/reset-confirm-form";
import { PASSWORD_MESSAGES } from "../../lib/student-password-validation";
import { REGISTRATION_NUMBER_TOO_LONG_MESSAGE } from "../../lib/student-validation";
import { PASSWORD_RESET_REQUESTED_MESSAGE } from "../../lib/password-reset-request-http";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const TOKEN = "a1".repeat(32); // 64 hex characters, the format of every issued token

type Call = { input: string; init?: RequestInit };
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return respond();
  };
  return { calls, impl };
}

/** Runs `fn` while recording every console call and every Web Storage access. */
async function watched<T>(fn: () => Promise<T>) {
  const logged: string[] = [];
  const storage: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  methods.forEach((m) => {
    console[m] = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  });
  const fakeStorage = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (storage.push(`${name}.${String(prop)}`), () => null) }) as Storage;
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage };
  g.localStorage = fakeStorage("localStorage");
  g.sessionStorage = fakeStorage("sessionStorage");
  try {
    return { result: await fn(), logged, storage };
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i];
    });
    g.localStorage = saved.localStorage;
    g.sessionStorage = saved.sessionStorage;
  }
}

// ---- Request page -------------------------------------------------------------------------------

test("request page: one field — students by registration number, teachers / guardians by email; no student-email instruction", () => {
  const html = renderToStaticMarkup(<ResetRequestView value="" />);
  assert.match(html, /<label for="loginId"[^>]*>Registration number or email<\/label>/);
  assert.match(html, /<input id="loginId" name="loginId" type="text" required="" autoComplete="username"[^>]*maxLength="254"/);
  assert.match(html, /aria-describedby="loginId-help"/);
  const words = text(html);
  assert.ok(words.includes("Students: enter your registration number. Teachers and guardians: enter your email address."));
  assert.doesNotMatch(words, /student[^.]*email/i, "students are never told to use an email");
  assert.match(html, /<form[^>]*novalidate=""/i);
  assert.doesNotMatch(html, /role="alert"|role="status"/, "nothing shown before submitting");

  const page = read("app/reset-password/page.tsx");
  assert.match(page, /<ResetRequestForm \/>/);
  assert.match(page, /Students: enter your registration number\. Teachers and guardians: enter your email address\. If an account exists, we'll send a reset link to its registered email address\./);
  assert.doesNotMatch(page, /Email or Registration Number|email or registration number and/i);
});

test("request checks: required; a registration number at most 64 characters (normalized like the server); emails up to 254", () => {
  assert.equal(checkResetRequestInput(""), RESET_REQUEST_MESSAGES.required);
  assert.equal(checkResetRequestInput("   "), RESET_REQUEST_MESSAGES.required);
  assert.equal(checkResetRequestInput("PK-2026-001"), null);
  assert.equal(checkResetRequestInput("  pk-2026-001  "), null);
  assert.equal(checkResetRequestInput("A".repeat(64)), null);
  assert.equal(checkResetRequestInput(` ${"A".repeat(64)} `), null, "measured after trimming");
  assert.equal(checkResetRequestInput("A".repeat(65)), REGISTRATION_NUMBER_TOO_LONG_MESSAGE);
  assert.equal(checkResetRequestInput("ß".repeat(33)), REGISTRATION_NUMBER_TOO_LONG_MESSAGE, "33 characters, 66 once upper-cased (as the server measures)");
  // Teachers and guardians: email addresses are never held to the 64-character registration rule.
  const longEmail = `${"t".repeat(80)}@school.example.com`;
  assert.equal(checkResetRequestInput(longEmail), null);
  assert.equal(checkResetRequestInput("Teacher@School.com"), null);
  const email = (length: number) => `${"g".repeat(length - "@example.com".length)}@example.com`;
  assert.equal(email(254).length, 254);
  assert.equal(checkResetRequestInput(email(254)), null, "254 characters");
  assert.equal(checkResetRequestInput(email(255)), RESET_REQUEST_MESSAGES.tooLong);
  assert.equal(RESET_LOGIN_ID_MAX_LENGTH, 254);
});

test("request: sends the trimmed entry to the existing endpoint once; same-origin, not cached", async () => {
  for (const entry of ["  PK-2026-001 ", " Teacher@School.com", "guardian@example.com"]) {
    const { calls, impl } = fakeFetch(() => json(200, { success: true, data: { requested: true }, message: PASSWORD_RESET_REQUESTED_MESSAGE }));
    const outcome = await submitResetRequest(entry, impl);
    assert.deepEqual(outcome, { ok: true, message: RESET_REQUEST_MESSAGES.generic });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, PASSWORD_RESET_REQUEST_ENDPOINT);
    assert.equal(calls[0].input, "/api/auth/password-reset/request");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.cache, "no-store");
    assert.equal(calls[0].init?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { loginId: entry.trim() });
  }
});

test("request: the success message is the generic one, whatever the server's body says — no account information", () => {
  assert.equal(RESET_REQUEST_MESSAGES.generic, PASSWORD_RESET_REQUESTED_MESSAGE, "the same words as the server");
  const bodies = [
    { success: true, data: { requested: true }, message: PASSWORD_RESET_REQUESTED_MESSAGE },
    { success: true, data: { requested: true } },
    { success: true, data: { requested: true, role: "STUDENT" }, message: "Sent to k***@mail.com" },
  ];
  for (const body of bodies) assert.deepEqual(mapResetRequestResponse(200, body, null), { ok: true, message: RESET_REQUEST_MESSAGES.generic });
  const html = renderToStaticMarkup(<ResetRequestView value="" message={RESET_REQUEST_MESSAGES.generic} />);
  assert.match(html, /role="status"/);
  assert.ok(text(html).includes("If an account exists, a reset link has been sent to the registered email address."));
});

test("request: 429 is a friendly wait (from Retry-After) with no account information", () => {
  const body = { success: false, error: { message: "Too many password reset requests. Please wait and try again.", code: "PASSWORD_RESET_RATE_LIMITED" } };
  assert.deepEqual(mapResetRequestResponse(429, body, "600"), { ok: false, message: "Too many reset requests. Please wait 10 minutes and try again." });
  assert.deepEqual(mapResetRequestResponse(429, body, "30"), { ok: false, message: "Too many reset requests. Please wait 1 minute and try again." });
  assert.deepEqual(mapResetRequestResponse(429, body, null), { ok: false, message: "Too many reset requests. Please wait a few minutes and try again." });
  assert.deepEqual(mapResetRequestResponse(429, null, "abc"), { ok: false, message: "Too many reset requests. Please wait a few minutes and try again." });
});

test("request: other failures — validation text, cross-origin, too large, server error, network", async () => {
  assert.deepEqual(mapResetRequestResponse(400, { success: false, error: { message: "Email or registration number is too long.", code: "VALIDATION_ERROR" } }, null), {
    ok: false,
    message: "Email or registration number is too long.",
  });
  assert.deepEqual(mapResetRequestResponse(403, { success: false, error: { code: "CROSS_ORIGIN_REQUEST_REJECTED", message: "x" } }, null), { ok: false, message: RESET_REQUEST_MESSAGES.crossOrigin });
  assert.deepEqual(mapResetRequestResponse(413, { success: false, error: { code: "REQUEST_TOO_LARGE" } }, null), { ok: false, message: RESET_REQUEST_MESSAGES.tooLong });
  assert.deepEqual(mapResetRequestResponse(500, { success: false, error: { message: "db down for teacher@school.com" } }, null), { ok: false, message: RESET_REQUEST_MESSAGES.failed });
  assert.deepEqual(mapResetRequestResponse(502, "<html>", null), { ok: false, message: RESET_REQUEST_MESSAGES.failed });
  const offline = await submitResetRequest("PK-1", async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(offline, { ok: false, message: RESET_REQUEST_MESSAGES.network });
  const notJson = await submitResetRequest("PK-1", async () => new Response("oops", { status: 500 }));
  assert.deepEqual(notJson, { ok: false, message: RESET_REQUEST_MESSAGES.failed });
});

// ---- Confirmation page --------------------------------------------------------------------------

test("confirm form: new password and confirmation, both required, labelled, new-password autocomplete, 64 max", () => {
  const html = renderToStaticMarkup(<ResetConfirmView phase="form" />);
  assert.equal((html.match(/<input/g) ?? []).length, 2);
  for (const [id, label] of [
    ["newPassword", "New password"],
    ["confirmPassword", "Confirm new password"],
  ] as const) {
    assert.match(html, new RegExp(`<label for="${id}"[^>]*>${label}</label>`));
    assert.match(html, new RegExp(`<input id="${id}" name="${id}" type="password" required="" autoComplete="new-password" maxLength="64"`));
  }
  assert.match(html, /<form[^>]*novalidate=""/i);
  assert.ok(text(html).includes("8–64 characters."));
  assert.doesNotMatch(html, /token/i, "the token is never rendered");
});

test("confirm checks: both required; mismatch blocks; shared rules 8–64 characters and 72 UTF-8 bytes", () => {
  const check = (newPassword: string, confirmPassword = newPassword) => checkResetPasswordFields({ newPassword, confirmPassword });
  assert.deepEqual(check("", ""), { newPassword: PASSWORD_MESSAGES.newRequired, confirmPassword: PASSWORD_MESSAGES.confirmRequired });
  assert.deepEqual(check("good-password-1", ""), { confirmPassword: PASSWORD_MESSAGES.confirmRequired });
  assert.deepEqual(check("good-password-1", "good-password-2"), { confirmPassword: PASSWORD_MESSAGES.mismatch });
  assert.deepEqual(check("good-password-1", "Good-password-1"), { confirmPassword: PASSWORD_MESSAGES.mismatch }, "exact match");
  assert.deepEqual(check("a".repeat(7)), { newPassword: PASSWORD_MESSAGES.tooShort });
  assert.deepEqual(check("a".repeat(8)), {});
  assert.deepEqual(check("a".repeat(64)), {});
  assert.deepEqual(check("a".repeat(65)), { newPassword: PASSWORD_MESSAGES.tooLong });
  assert.deepEqual(check("අ".repeat(24)), {}, "24 Sinhala characters = 72 bytes");
  assert.deepEqual(check("අ".repeat(25)), { newPassword: PASSWORD_MESSAGES.tooManyBytes }, "25 characters, 75 bytes");
});

test("confirm checks: no role's rules are applied to everyone", () => {
  const check = (password: string) => checkResetPasswordFields({ newPassword: password, confirmPassword: password });
  // A student's or guardian's length-only password is not refused for missing character classes...
  for (const password of ["onlylowercase", "ALLUPPERCASE", "12345678", "plain words here"]) assert.deepEqual(check(password), {}, password);
  // ...and a teacher-style complex password is accepted too.
  assert.deepEqual(check("Teacher-Pass1"), {});
  // The registration-number rule needs the account: it is the server's (shown as its message).
  assert.deepEqual(check("PK-2026-001"), {});
  const source = read("components/password-reset/reset-confirm-form.tsx");
  assert.doesNotMatch(source, /\/\[a-z\]\/|\/\[A-Z\]\/|\/\[0-9\]\//, "no character-class checks in the shared form");
});

test("confirm: sends the token and new password (not the confirmation) to the existing endpoint, no referrer", async () => {
  const { calls, impl } = fakeFetch(() => json(200, { success: true, data: { updated: true }, message: "Password reset successfully." }));
  const outcome = await submitResetConfirm(TOKEN, { newPassword: "brand-new-pass", confirmPassword: "brand-new-pass" }, impl);
  assert.deepEqual(outcome, { kind: "done" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, PASSWORD_RESET_CONFIRM_ENDPOINT);
  assert.equal(calls[0].input, "/api/auth/password-reset/confirm", "relative: the page's own origin (HTTPS in production)");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { token: TOKEN, newPassword: "brand-new-pass" });
});

test("confirm answers: invalid / expired / used link is one generic state; validation, conflict, 429, errors, network", async () => {
  const invalid = { success: false, error: { message: "Reset link is invalid or expired.", code: "INVALID_RESET_TOKEN" } };
  assert.deepEqual(mapResetConfirmResponse(400, invalid, null), { kind: "invalid-link" });
  assert.deepEqual(mapResetConfirmResponse(400, { success: false, error: { message: PASSWORD_MESSAGES.registrationNumber, code: "VALIDATION_ERROR", details: { field: "newPassword" } } }, null), {
    kind: "error",
    message: PASSWORD_MESSAGES.registrationNumber,
    field: "newPassword",
  });
  assert.deepEqual(mapResetConfirmResponse(409, { success: false, error: { code: "PASSWORD_RESET_CONFLICT", message: "x" } }, null), { kind: "error", message: RESET_CONFIRM_MESSAGES.conflict, field: null });
  assert.deepEqual(mapResetConfirmResponse(429, { success: false, error: { code: "X" } }, "120"), { kind: "error", message: "Too many attempts. Please wait 2 minutes and try again.", field: null });
  assert.deepEqual(mapResetConfirmResponse(500, { success: false, error: { message: "boom at /srv/app" } }, null), { kind: "error", message: RESET_CONFIRM_MESSAGES.failed, field: null });
  assert.deepEqual(mapResetConfirmResponse(400, { success: false, error: { code: "INVALID_JSON", message: "Invalid JSON payload." } }, null), { kind: "error", message: RESET_CONFIRM_MESSAGES.failed, field: null });
  const offline = await submitResetConfirm(TOKEN, { newPassword: "brand-new-pass", confirmPassword: "brand-new-pass" }, async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(offline, { kind: "error", message: RESET_CONFIRM_MESSAGES.network, field: null });
  // One fixed sentence for invalid, expired and used links: nothing about the account or the token.
  assert.equal(RESET_CONFIRM_MESSAGES.invalidLink, "This reset link is invalid, has expired or has already been used. Request a new link and try again.");
});

test("confirm views: success has a Sign in link and no password fields; invalid / missing links offer a new one", () => {
  const done = renderToStaticMarkup(<ResetConfirmView phase="done" values={{ newPassword: "x", confirmPassword: "x" }} />);
  assert.match(done, /role="status"/);
  assert.ok(text(done).includes("Your password has been reset. You have been signed out everywhere — sign in with your new password."));
  assert.match(done, /<a[^>]*href="\/login"[^>]*>Sign in<\/a>/);
  assert.doesNotMatch(done, /<input/, "the password fields are gone");

  for (const phase of ["invalid-link", "missing"] as const) {
    const html = renderToStaticMarkup(<ResetConfirmView phase={phase} />);
    assert.match(html, /role="alert"/);
    assert.match(html, /<a[^>]*href="\/reset-password"[^>]*>Request a new reset link<\/a>/);
    assert.doesNotMatch(html, /<input/);
  }
  assert.ok(text(renderToStaticMarkup(<ResetConfirmView phase="invalid-link" />)).includes(RESET_CONFIRM_MESSAGES.invalidLink));
  assert.match(renderToStaticMarkup(<ResetConfirmView phase="loading" />), /Checking your reset link/);
  const withError = renderToStaticMarkup(<ResetConfirmView phase="form" errors={{ confirmPassword: PASSWORD_MESSAGES.mismatch }} errorMessage="Network down" />);
  assert.match(withError, /<input id="confirmPassword"[^>]*aria-invalid="true"[^>]*aria-describedby="confirmPassword-error"/);
  assert.match(withError, /<p id="confirmPassword-error" role="alert"[^>]*>Passwords do not match\.<\/p>/);
});

test("confirm container: blocks on client errors, clears the fields and drops the token after success or a refused link", () => {
  const source = read("components/password-reset/reset-confirm-form.tsx");
  const submit = source.slice(source.indexOf("async function handleSubmit"));
  assert.match(submit, /const found = checkResetPasswordFields\(values\);\s*setErrors\(found\);\s*if \(Object\.keys\(found\)\.length > 0\) return;/, "no request while the checks fail");
  assert.ok(submit.indexOf("checkResetPasswordFields") < submit.indexOf("submitResetConfirm"));
  assert.match(submit, /if \(outcome\.kind === "done" \|\| outcome\.kind === "invalid-link"\) \{\s*tokenRef\.current = null;\s*setValues\(EMPTY\);/);
  assert.match(submit, /if \(inFlight\.current\) return;/, "one request at a time");
});

// ---- Token protection ---------------------------------------------------------------------------

function fakeHistory() {
  const calls: { data: unknown; url: string | null | undefined }[] = [];
  return { calls, replaceState: (data: unknown, _unused: string, url?: string | null) => calls.push({ data, url }) };
}

test("token: read from the original address and removed from it (the history entry is replaced, not added)", () => {
  const history = fakeHistory();
  const token = takeResetTokenFromLocation({ href: `https://slclassroom.live/reset-password/confirm?token=${TOKEN}` }, history);
  assert.equal(token, TOKEN);
  assert.deepEqual(history.calls, [{ data: null, url: "/reset-password/confirm" }]);
  assert.ok(!String(history.calls[0].url).includes(TOKEN));

  // Other parameters and the fragment survive; only the token goes.
  const other = fakeHistory();
  assert.equal(takeResetTokenFromLocation({ href: `https://slclassroom.live/reset-password/confirm?utm=x&token=${TOKEN}#top` }, other), TOKEN);
  assert.deepEqual(other.calls.map((c) => c.url), ["/reset-password/confirm?utm=x#top"]);
});

test("token: missing -> null and the address is left alone; malformed -> null but still removed from the address", () => {
  const none = fakeHistory();
  assert.equal(takeResetTokenFromLocation({ href: "https://slclassroom.live/reset-password/confirm" }, none), null);
  assert.equal(none.calls.length, 0);
  for (const bad of ["", "abc", `${TOKEN}0`, "z".repeat(64), "<script>"]) {
    const history = fakeHistory();
    assert.equal(takeResetTokenFromLocation({ href: `https://slclassroom.live/reset-password/confirm?token=${encodeURIComponent(bad)}` }, history), null, bad);
    assert.deepEqual(history.calls.map((c) => c.url), ["/reset-password/confirm"], bad);
  }
  assert.equal(takeResetTokenFromLocation({ href: "not a url" }, fakeHistory()), null);
});

test("token: back / forward cannot restore it — after removal the only history entry for the page has no token", () => {
  // A minimal history stack: the email link opened the page (one entry); replaceState rewrites that entry.
  const stack = [`/reset-password/confirm?token=${TOKEN}`];
  let index = 0;
  const history = { replaceState: (_d: unknown, _u: string, url?: string | null) => (stack[index] = String(url)) };
  takeResetTokenFromLocation({ href: `https://slclassroom.live${stack[index]}` }, history);
  assert.deepEqual(stack, ["/reset-password/confirm"]);
  assert.ok(stack.every((entry) => !entry.includes(TOKEN)));
  index = 0; // "back" / "forward" land on the same rewritten entry
  assert.equal(stack[index], "/reset-password/confirm");
});

test("token: never logged and never put in Web Storage — reading, submitting and every answer", async () => {
  const { logged, storage } = await watched(async () => {
    takeResetTokenFromLocation({ href: `https://slclassroom.live/reset-password/confirm?token=${TOKEN}` }, fakeHistory());
    for (const respond of [
      () => json(200, { success: true }),
      () => json(400, { success: false, error: { code: "INVALID_RESET_TOKEN" } }),
      () => json(500, { success: false }),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      await submitResetConfirm(TOKEN, { newPassword: "brand-new-pass", confirmPassword: "brand-new-pass" }, async () => respond());
    }
  });
  assert.deepEqual(logged, []);
  assert.deepEqual(storage, []);
  const source = read("components/password-reset/reset-confirm-form.tsx");
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB|console\./);
  assert.doesNotMatch(read("components/password-reset/reset-request-form.tsx"), /localStorage|sessionStorage|document\.cookie|console\./);
});

test("token: the page reads it once on mount, from window.location, into memory only — never from server-rendered search params", () => {
  const source = read("components/password-reset/reset-confirm-form.tsx");
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*\/\/[^\n]*\n\s*if \(tokenRead\.current\) return;\s*tokenRead\.current = true;\s*tokenRef\.current = takeResetTokenFromLocation\(window\.location, window\.history\);/
  );
  assert.match(source, /const tokenRef = useRef<string \| null>\(null\);/);
  assert.doesNotMatch(source, /useSearchParams|useState<string>\(\s*token/);
  assert.doesNotMatch(source, /\{tokenRef\.current\}|value=\{token/, "never rendered");
  const page = read("app/reset-password/confirm/page.tsx");
  assert.match(page, /<ResetConfirmForm \/>/);
  assert.doesNotMatch(page, /useSearchParams|searchParams/);
});

test("token: the reset email link format is unchanged (/reset-password/confirm?token=…)", () => {
  const mailer = read("lib/mailer.ts");
  assert.match(mailer, /const url = new URL\("\/reset-password\/confirm", baseUrl\);\s*url\.searchParams\.set\("token", token\);/);
});

// ---- Page security ------------------------------------------------------------------------------

test("reset pages: no referrer (meta + header), rendered per request (no-store), not indexed", async () => {
  const layout = await import("../../app/reset-password/layout");
  assert.equal(layout.dynamic, "force-dynamic");
  assert.equal(layout.metadata.referrer, "no-referrer");
  assert.deepEqual(layout.metadata.robots, { index: false, follow: false });

  const config = (await import(pathToFileURL(path.join(ROOT, "next.config.mjs")).href)).default;
  const rules = await config.headers();
  assert.deepEqual(rules, [
    { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    { source: "/reset-password/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
  ]);
});

test("unrelated pages are unaffected: the layout sits only under /reset-password; no global header or middleware change", async () => {
  const config = (await import(pathToFileURL(path.join(ROOT, "next.config.mjs")).href)).default;
  const rules: { source: string }[] = await config.headers();
  assert.ok(rules.every((rule) => rule.source === "/reset-password" || rule.source.startsWith("/reset-password/")));
  assert.doesNotMatch(read("middleware.ts"), /reset-password|Referrer-Policy/);
  assert.doesNotMatch(read("app/layout.tsx"), /no-referrer/);
});
