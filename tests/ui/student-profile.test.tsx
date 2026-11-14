/**
 * Student Profile SP-2 / SP-3: the student-facing profile page (SP-3: phone editing)
 * (components/student-portal/student-profile.tsx, app/student/profile/page.tsx)
 * and the portal navigation entry. Views render with react-dom/server; the
 * loader runs over a fake fetch with real Response objects. No browser, no
 * server.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PROFILE_ENDPOINT,
  ProfileErrorView,
  ProfileLoadingView,
  PHONE_EDIT_BUTTON_ID,
  PHONE_INPUT_ID,
  PhoneField,
  ProfileView,
  checkPhoneInput,
  createPhoneEditor,
  formatRegistrationDate,
  loadStudentProfile,
  readStudentProfile,
  submitStudentPhone,
  type PhoneEditState,
  type PhoneSaveResult,
  type StudentProfileData,
} from "../../components/student-portal/student-profile";
import { studentNavItems } from "../../components/student-portal/student-data";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const PROFILE: StudentProfileData = {
  name: "Amal Perera",
  registrationNumber: "STU-0042",
  email: "amal@example.test",
  emailVerified: true,
  phone: "0771234567",
  registeredOn: "2026-07-25",
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---- The loader ------------------------------------------------------------------------------

test("loader: GET the session-scoped endpoint (no student id sent), same-origin, no-store; maps the profile", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await loadStudentProfile({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(200, { success: true, data: PROFILE });
    },
  });
  assert.deepEqual(result, { ok: true, profile: PROFILE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/students/me/profile");
  assert.equal(PROFILE_ENDPOINT, "/api/students/me/profile");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.method ?? "GET", "GET");
  assert.equal(calls[0].init?.body, undefined);
});

test("loader: 401, inactive, not found, server error, network failure and malformed data map to fixed messages", async () => {
  const run = (response: Response | Error) => loadStudentProfile({ fetchImpl: async () => (response instanceof Error ? Promise.reject(response) : response) });
  const err = (status: number, code: string) => json(status, { success: false, error: { message: "server internal text", code } });

  const unauthorized = await run(err(401, "UNAUTHORIZED"));
  assert.deepEqual(unauthorized.ok === false && [unauthorized.status, unauthorized.code], [401, "UNAUTHORIZED"]);
  const inactive = await run(err(403, "STUDENT_ACCOUNT_INACTIVE"));
  assert.equal(!inactive.ok && inactive.code, "STUDENT_ACCOUNT_INACTIVE");
  const missing = await run(err(404, "STUDENT_NOT_FOUND"));
  assert.equal(!missing.ok && missing.code, "STUDENT_NOT_FOUND");
  const server = await run(err(500, "INTERNAL_SERVER_ERROR"));
  assert.equal(!server.ok && server.code, "SERVER_ERROR");
  const html = await run(new Response("<html>bad gateway</html>", { status: 502 }));
  assert.equal(!html.ok && html.code, "SERVER_ERROR");
  const network = await run(new TypeError("offline"));
  assert.deepEqual(!network.ok && [network.status, network.code], [0, "NETWORK_ERROR"]);
  for (const r of [unauthorized, inactive, missing, server, network]) assert.ok(!r.ok && !r.message.includes("server internal text"), "never server text");

  for (const data of [null, {}, { ...PROFILE, name: 7 }, { ...PROFILE, emailVerified: "yes" }, { ...PROFILE, registeredOn: "2026-07-25T09:02:27Z" }]) {
    const r = await run(json(200, { success: true, data }));
    assert.equal(!r.ok && r.code, "INVALID_RESPONSE", JSON.stringify(data));
  }
  // Extra fields from the server are never carried into the page.
  const extra = readStudentProfile({ ...PROFILE, teacherId: "t-1", password: "hash" }) as Record<string, unknown>;
  assert.ok(!("teacherId" in extra) && !("password" in extra));
});

// ---- The views -------------------------------------------------------------------------------

test("profile view: every field shown, the name marked as teacher-managed, no editable control", () => {
  const html = renderToStaticMarkup(<ProfileView profile={PROFILE} />);
  const t = text(html);
  for (const value of ["Amal Perera", "STU-0042", "amal@example.test", "Verified", "0771234567", "25 Jul 2026"]) assert.ok(t.includes(value), value);
  assert.ok(t.includes("Name managed by your teacher"));
  assert.ok(t.includes("Contact your teacher if it needs to be corrected."));
  assert.doesNotMatch(html, /<input|<textarea|<select|<form|contenteditable/i, "read only");
  assert.doesNotMatch(t, /\bEdit\b|\bSave\b|Change name/i, "no wording that suggests editing");
  assert.match(html, /href="\/student\/settings"/, "password management stays in Settings (SP-4: the QR is on this page)");
  assert.match(html, /<dl[^>]*class="[^"]*grid-cols-1[^"]*sm:grid-cols-2/, "one column on phones, two from small screens");
});

test("profile view: missing values and an unverified email are labelled in text (not colour alone)", () => {
  const t = text(renderToStaticMarkup(<ProfileView profile={{ ...PROFILE, email: "amal@example.test", emailVerified: false, phone: null, registrationNumber: null, registeredOn: null }} />));
  assert.ok(t.includes("Not verified"));
  assert.equal((t.match(/Not provided/g) ?? []).length, 2, "phone and student ID");
  assert.ok(t.includes("Not available"), "registration date");
  const noEmail = text(renderToStaticMarkup(<ProfileView profile={{ ...PROFILE, email: null }} />));
  assert.ok(!noEmail.includes("Verified") && noEmail.includes("Not provided"));
});

test("loading and error views: status / alert roles; retry only when retrying can help; sign-in for session problems", () => {
  const loading = renderToStaticMarkup(<ProfileLoadingView />);
  assert.match(loading, /role="status"/);
  assert.ok(text(loading).includes("Loading your profile"));

  const view = (code: string) => renderToStaticMarkup(<ProfileErrorView error={{ status: 0, code, message: `msg ${code}` }} onRetry={() => {}} />);
  for (const code of ["NETWORK_ERROR", "SERVER_ERROR", "INVALID_RESPONSE"]) {
    const html = view(code);
    assert.match(html, /role="alert"/);
    assert.ok(text(html).includes("Try again"), code);
    assert.ok(!html.includes('href="/login"'), code);
  }
  for (const code of ["UNAUTHORIZED", "STUDENT_NOT_FOUND"]) {
    const html = view(code);
    assert.ok(html.includes('href="/login"'), code);
    assert.ok(!text(html).includes("Try again"), code);
  }
  const inactive = text(view("STUDENT_ACCOUNT_INACTIVE"));
  assert.ok(inactive.includes("msg STUDENT_ACCOUNT_INACTIVE") && !inactive.includes("Try again") && !inactive.includes("Sign in"));
});

test("registration date: a calendar date, no time zone shift, never a time", () => {
  assert.equal(formatRegistrationDate("2026-07-25"), "25 Jul 2026");
  assert.equal(formatRegistrationDate("2026-01-01"), "1 Jan 2026");
  assert.equal(formatRegistrationDate(null), "Not available");
  assert.equal(formatRegistrationDate("2026-07-25T09:02:27Z"), "Not available");
});

// ---- The page and the navigation ---------------------------------------------------------------

test("page: /student/profile renders the profile panel (no redirect any more)", () => {
  const page = source("app", "student", "profile", "page.tsx");
  assert.doesNotMatch(page, /redirect\(/);
  assert.match(page, /<StudentProfilePanel \/>/);
  const panel = source("components", "student-portal", "student-profile.tsx");
  assert.match(panel, /loadStudentProfile\(\{ signal \}\)/, "loads on mount with an abortable request");
  assert.match(panel, /return \(\) => \{\s*mounted\.current = false;\s*controller\.abort\(\);\s*\};/, "aborted on unmount (and no state updates after it)");
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\./);
});

test("navigation: one 'My Profile' entry linking to /student/profile with its own icon; the other entries unchanged", () => {
  const profileItems = studentNavItems.filter((item) => item.href === "/student/profile");
  assert.deepEqual(profileItems, [{ href: "/student/profile", label: "My Profile", icon: "profile" }]);
  assert.deepEqual(
    studentNavItems.filter((item) => item.href !== "/student/profile").map((item) => item.href),
    [
      "/student/dashboard",
      "/student/calendar",
      "/student/classes",
      "/student/lectures",
      "/student/recorded-lectures", // Recorded Lectures RL-5.1 (approved entry point D-2)
      "/student/assignments",
      "/student/quizzes",
      "/student/papers",
      "/student/payments",
      "/student/material-bundles",
      "/student/attendance",
      "/student/messages",
      "/student/settings",
    ]
  );
  const sidebar = source("components", "student-portal", "student-sidebar.tsx");
  assert.match(sidebar, /profile:\s+UserRound,/);
  // Active highlighting: the shell picks the exact nav entry for /student/profile.
  const shell = source("components", "student-portal", "student-shell.tsx");
  assert.match(shell, /const exact = studentNavItems\.find\(\(item\) => item\.href === pathname\);/);
  // Teacher navigation untouched.
  assert.doesNotMatch(source("components", "dashboard-shell.tsx"), /student\/profile/);
});

// ---- SP-3: editing the phone number -----------------------------------------------------------

const noop = () => {};
const editor = (state: PhoneEditState, phone: string | null = PROFILE.phone) => ({ phone, state, onEdit: noop, onDraftChange: noop, onSave: noop, onCancel: noop });
const editing = (patch: Partial<Extract<PhoneEditState, { mode: "edit" }>> = {}): PhoneEditState => ({ mode: "edit", draft: "0771234567", problem: null, submitting: false, signIn: false, ...patch });

test("phone view: an Edit action beside the phone only; every other field stays read only", () => {
  const html = renderToStaticMarkup(<ProfileView profile={PROFILE} phoneEditor={editor({ mode: "view" })} />);
  const t = text(html);
  assert.ok(t.includes("0771234567"));
  assert.equal((html.match(/<button/g) ?? []).length, 1, "a single action on the page");
  assert.match(html, new RegExp(`<button type="button" id="${PHONE_EDIT_BUTTON_ID}"`));
  assert.ok(t.includes("Edit phone number"), "the button names what it edits");
  assert.doesNotMatch(html, /<input|<textarea|<select|<form/i, "no form until Edit is pressed");
  for (const value of ["Amal Perera", "STU-0042", "amal@example.test", "25 Jul 2026"]) assert.ok(t.includes(value));
  const none = text(renderToStaticMarkup(<ProfileView profile={{ ...PROFILE, phone: null }} phoneEditor={editor({ mode: "view" }, null)} />));
  assert.ok(none.includes("Not provided") && none.includes("Edit"), "a missing phone can be added");
});

test("phone edit: one labelled tel input with the current draft, help text, Save and Cancel; no other input", () => {
  const html = renderToStaticMarkup(<ProfileView profile={PROFILE} phoneEditor={editor(editing({ draft: "+94 77 000 1111" }))} />);
  assert.equal((html.match(/<input/g) ?? []).length, 1, "only the phone is editable");
  assert.match(html, new RegExp(`<label for="${PHONE_INPUT_ID}">Phone</label>`));
  assert.match(html, new RegExp(`<input id="${PHONE_INPUT_ID}" type="tel"[^>]*autoComplete="tel"[^>]*value="\\+94 77 000 1111"`));
  assert.match(html, /<button type="submit"[^>]*>Save<\/button>/);
  assert.match(html, /<button type="button"[^>]*>Cancel<\/button>/);
  assert.ok(text(html).includes("Digits, spaces, + and - only (9–20 characters)."));
  assert.doesNotMatch(html, /role="alert"|aria-invalid|disabled=""/, "no error, nothing disabled");
});

test("phone edit: a problem is an alert tied to the input; sign-in link only for session problems", () => {
  const html = renderToStaticMarkup(<PhoneField {...editor(editing({ problem: "Please enter a valid phone number." }))} />);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="student-profile-phone-help student-profile-phone-error"/);
  assert.match(html, /<p id="student-profile-phone-error" role="alert"[^>]*>Please enter a valid phone number\.<\/p>/);
  assert.doesNotMatch(html, /href="\/login"/);
  const expired = renderToStaticMarkup(<PhoneField {...editor(editing({ problem: "Your session has expired.", signIn: true }))} />);
  assert.match(expired, /href="\/login"[^>]*>Sign in<\/a>/);
});

test("phone edit: while saving, Save shows 'Saving…' and input, Save and Cancel are disabled", () => {
  const html = renderToStaticMarkup(<PhoneField {...editor(editing({ submitting: true }))} />);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.ok(text(html).includes("Saving…"));
  assert.doesNotMatch(text(html), /\bSave\b(?!…)/);
});

test("checkPhoneInput: the server's own rule (trimmed; empty not allowed)", () => {
  assert.deepEqual(checkPhoneInput("  077 123 4567 "), { ok: true, value: "077 123 4567" });
  assert.deepEqual(checkPhoneInput(""), { ok: false, message: "Enter a phone number." });
  assert.deepEqual(checkPhoneInput("   "), { ok: false, message: "Enter a phone number." });
  assert.deepEqual(checkPhoneInput("12345"), { ok: false, message: "Please enter a valid phone number." });
  assert.deepEqual(checkPhoneInput("077-ABC-4567"), { ok: false, message: "Phone number can only contain digits, spaces, + and -." });
  assert.deepEqual(checkPhoneInput("1".repeat(21)), { ok: false, message: "Phone number is too long." });
});

test("submitStudentPhone: PATCH exactly { contact01 } to the session endpoint, same-origin, no-store; maps the profile", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await submitStudentPhone("0779998887", {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(200, { success: true, message: "Your phone number was updated.", data: { ...PROFILE, phone: "0779998887" } });
    },
  });
  assert.deepEqual(result, { ok: true, profile: { ...PROFILE, phone: "0779998887" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/students/me/profile");
  assert.equal(calls[0].init?.method, "PATCH");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.body, JSON.stringify({ contact01: "0779998887" }), "no id, no other field");
});

test("submitStudentPhone: expired session, validation, rate limit, inactive, not found, cross-origin, server and network errors", async () => {
  const run = (status: number, body: unknown) => submitStudentPhone("0779998887", { fetchImpl: async () => json(status, body) });
  const err = (code: string, message = "server text", details?: unknown) => ({ success: false, error: { code, message, details } });

  const expired = await run(401, err("UNAUTHORIZED"));
  assert.deepEqual([expired.ok, !expired.ok && expired.code], [false, "UNAUTHORIZED"]);
  assert.match(!expired.ok ? expired.message : "", /session has expired/);

  const invalid = await run(400, err("VALIDATION_ERROR", "Please enter a valid phone number.", { field: "contact01" }));
  assert.deepEqual(invalid, { ok: false, status: 400, code: "VALIDATION_ERROR", message: "Please enter a valid phone number.", field: "contact01" });

  const body = await run(400, err("VALIDATION_ERROR", "<b>server text</b>", { field: "body" }));
  assert.equal(!body.ok && body.code, "SERVER_ERROR", "only the field's validation text is shown from the server");

  const mapped: [number, string, RegExp][] = [
    [429, "PROFILE_UPDATE_RATE_LIMITED", /Too many changes/],
    [403, "STUDENT_ACCOUNT_INACTIVE", /inactive/],
    [404, "STUDENT_NOT_FOUND", /could not be found/],
    [403, "CROSS_ORIGIN_REQUEST_REJECTED", /blocked for security/],
  ];
  for (const [status, code, pattern] of mapped) {
    const result = await run(status, err(code));
    assert.equal(!result.ok && result.code, code);
    assert.match(!result.ok ? result.message : "", pattern);
    assert.doesNotMatch(!result.ok ? result.message : "", /server text/);
  }

  for (const response of [json(500, err("INTERNAL_ERROR")), new Response("<html>", { status: 502 }), json(200, { success: true, data: { phone: 1 } })]) {
    const result = await submitStudentPhone("0779998887", { fetchImpl: async () => response });
    assert.equal(!result.ok && result.code, "SERVER_ERROR");
    assert.match(!result.ok ? result.message : "", /was not changed/);
  }

  const offline = await submitStudentPhone("0779998887", {
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.deepEqual([!offline.ok && offline.code, !offline.ok && offline.status], ["NETWORK_ERROR", 0]);
});

function harness(initial: PhoneEditState, submit: (value: string) => Promise<PhoneSaveResult>) {
  let state = initial;
  const saved: StudentProfileData[] = [];
  const sent: string[] = [];
  const flow = createPhoneEditor({
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    onSaved: (profile) => saved.push(profile),
    submit: (value) => {
      sent.push(value);
      return submit(value);
    },
  });
  return {
    flow,
    saved,
    sent,
    state: () => state,
    set: (next: PhoneEditState) => {
      state = next;
    },
  };
}
const neverCalled = async (): Promise<PhoneSaveResult> => {
  throw new Error("must not be called");
};

test("phone editor: an invalid draft sends nothing and shows the reason; the form stays open", async () => {
  const h = harness(editing({ draft: "12" }), neverCalled);
  assert.equal(await h.flow.save(), "INVALID");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.state(), editing({ draft: "12", problem: "Please enter a valid phone number." }));
  h.set(editing({ draft: "" }));
  assert.equal(await h.flow.save(), "INVALID");
  const after = h.state();
  assert.equal(after.mode === "edit" && after.problem, "Enter a phone number.");
  assert.deepEqual(h.sent, []);
});

test("phone editor: a successful save sends the trimmed value once, updates the profile and returns to view", async () => {
  let release: (r: PhoneSaveResult) => void = noop;
  const h = harness(editing({ draft: " 0779998887 " }), () => new Promise<PhoneSaveResult>((resolve) => (release = resolve)));
  const first = h.flow.save();
  assert.equal(h.flow.isSaving(), true);
  assert.deepEqual(h.state(), editing({ draft: " 0779998887 ", submitting: true }), "submitting state shown");
  assert.equal(await h.flow.save(), "IGNORED", "a second Save while one is in flight sends nothing");
  assert.deepEqual(h.sent, ["0779998887"]);
  release({ ok: true, profile: { ...PROFILE, phone: "0779998887" } });
  assert.equal(await first, "SAVED");
  assert.deepEqual(h.state(), { mode: "view" });
  assert.deepEqual(h.saved, [{ ...PROFILE, phone: "0779998887" }], "the display comes from the server's answer");
  assert.equal(h.flow.isSaving(), false);
});

test("phone editor: a failed save keeps the form open with the draft and the reason; sign-in offered for session problems", async () => {
  const fail = (code: string, message: string): PhoneSaveResult => ({ ok: false, status: 0, code, message, field: null });
  const server = harness(editing({ draft: "0779998887" }), async () => fail("SERVER_ERROR", "Something went wrong."));
  assert.equal(await server.flow.save(), "FAILED");
  assert.deepEqual(server.state(), editing({ draft: "0779998887", problem: "Something went wrong." }));
  assert.deepEqual(server.saved, []);
  assert.equal(server.flow.isSaving(), false, "can try again");

  for (const code of ["UNAUTHORIZED", "STUDENT_NOT_FOUND"]) {
    const h = harness(editing({ draft: "0779998887" }), async () => fail(code, "Please sign in again."));
    assert.equal(await h.flow.save(), "FAILED");
    assert.deepEqual(h.state(), editing({ draft: "0779998887", problem: "Please sign in again.", signIn: true }));
  }
});

test("phone editor: Save in view mode (e.g. after Cancel) does nothing", async () => {
  const h = harness({ mode: "view" }, neverCalled);
  assert.equal(await h.flow.save(), "IGNORED");
  assert.deepEqual(h.sent, []);
});

test("panel wiring: Cancel returns to view (ignored while saving), success notice, focus handled, only the phone is sent", () => {
  const code = source("components", "student-portal", "student-profile.tsx");
  const panel = code.slice(code.indexOf("export function StudentProfilePanel"));
  assert.match(panel, /onCancel: \(\) => \{\s*if \(!editor\.current\.isSaving\(\)\) setPhoneState\(\{ mode: "view" \}\);/);
  assert.match(panel, /setNotice\("Your phone number was updated\."\)/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /PHONE_INPUT_ID\)\?\.focus\(\)/);
  assert.match(panel, /PHONE_EDIT_BUTTON_ID\)\?\.focus\(\)/);
  assert.deepEqual(code.match(/JSON\.stringify\([^)]*\)/g), ["JSON.stringify({ contact01 })"], "the only body sent is { contact01 }");
  assert.doesNotMatch(code, /studentId/);
});
