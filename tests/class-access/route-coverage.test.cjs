/*
 * Payment-due access control: coverage of the student-facing API routes.
 *
 * Every route a student can call (requireStudentSession, the breakout
 * requireBreakoutStudent, or requireAppSession accepting STUDENT) must either
 *  - enforce the class access check: call assertContentAccessForStudent /
 *    assertClassAccessForStudent itself, or go through a function / module
 *    verified below to make the check; or
 *  - for RESOURCES (monthly resource access, services/resource-access-service.ts):
 *    call assertResourceAccessForStudent (delivery: the resource's billing
 *    month) or mark every listed item with resourceLockFor (listings); or
 *  - be listed in EXEMPT with the reason it is intentionally reachable while a
 *    class is restricted (account, payments, lists, presence, ...).
 * A new student route that does neither fails this test until it is
 * protected or consciously exempted. Static analysis only (no server).
 *
 *   npm run test:class-access
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const CHECK = /\bassert(Content|Class)AccessForStudent\(/;
// Monthly resource access: delivery check and per-item listing locks.
const RESOURCE_CHECK = /\bassertResourceAccessForStudent\(/;
const RESOURCE_LISTING = /\bresourceLockFor\(/;

// Functions that make the check inside (verified in "enforcing functions").
const ENFORCING_FUNCTIONS = {
  getSessionJoinInfo: "services/session-service.ts",
  markStudentJoinedSession: "services/session-service.ts",
  assertStudentCanWatchWhiteboard: "services/lecture-whiteboard-service.ts",
};

// Breakout services: every student entry goes through requireEnrolledStudentSessionAccess
// (lib/breakout-activities/student-access.ts) directly or via groups/access.ts.
const ENFORCING_MODULES = [
  "services/breakout-student-assignment-service.ts",
  "services/breakout-student-quiz-service.ts",
  "services/breakout-group-assignment-service.ts",
  "services/breakout-group-quiz-service.ts",
  "services/breakout-group-overview-service.ts",
];

const LIST = "list or summary only (titles / counts; opening an item is enforced), as agreed";
const EXEMPT = {
  // Account, identity and support
  "app/api/students/me/profile/route.ts": "own account",
  "app/api/students/me/qr/route.ts": "own attendance QR (account)",
  "app/api/students/me/qr/issue/route.ts": "own attendance QR (account)",
  "app/api/students/me/qr/regenerate/route.ts": "own attendance QR (account)",
  "app/api/students/me/qr/status/route.ts": "own attendance QR (account)",
  "app/api/students/me/attendance/route.ts": "own attendance history",
  "app/api/students/me/messages/route.ts": "messages from the teacher (support / contact)",
  "app/api/students/me/paper-support-messages/route.ts": "support messages with the teacher",
  // Payments (must stay available)
  "app/api/student/payments/route.ts": "payments",
  "app/api/student/payments/[paymentId]/messages/route.ts": "payment clarification messages",
  "app/api/payments/[paymentId]/slip/route.ts": "own payment slip",
  "app/api/payments/messages/[messageId]/file/route.ts": "payment message proof file",
  "app/api/student/dashboard/payments/route.ts": "payments due",
  // Own work
  "app/api/class-papers/[paperId]/submissions/[submissionId]/file/route.ts": "the student's own paper submission",
  // Classroom presence / leaving (no content; the classroom itself needs join-info, which is enforced)
  "app/api/sessions/[id]/leave/route.ts": "leaving must always work",
  "app/api/sessions/[id]/participant-map/route.ts": "presence metadata only",
  "app/api/sessions/[id]/register/route.ts": "class register (attendance list) only",
  "app/api/sessions/[id]/live-updates/route.ts": "presence / group event metadata only",
  "app/api/student/live/stream/route.ts": "live session list; YouTube watch links of restricted classes are filtered in lib/youtube-live-status.ts, Jitsi needs enforced join-info",
  // Lists, dashboards and calendars
  "app/api/student/calendar/route.ts": LIST,
  "app/api/student/dashboard/assignments-due/route.ts": LIST,
  "app/api/student/dashboard/counts/route.ts": LIST,
  "app/api/student/dashboard/papers/route.ts": LIST,
  "app/api/student/dashboard/performance/route.ts": LIST,
  "app/api/student/dashboard/quizzes/route.ts": LIST,
  "app/api/student/dashboard/schedule/route.ts": LIST,
  "app/api/student/lectures/route.ts": LIST,
  "app/api/student/quizzes/route.ts": LIST,
  "app/api/student/recorded-lectures/route.ts": LIST,
  "app/api/students/me/assignments/route.ts": LIST,
  "app/api/students/me/quizzes/route.ts": LIST,
};

function routeFiles(dir = "app/api") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...routeFiles(rel));
    else if (entry.name === "route.ts") out.push(rel);
  }
  return out;
}

/** Whether a route's source lets a student in. */
function isStudentFacing(source) {
  return (
    /\brequireStudentSession\(|\brequireBreakoutStudent\(/.test(source) ||
    (/\brequireAppSession\(/.test(source) && /"STUDENT"/.test(source))
  );
}

/** How a route's source enforces the check (null: it does not). */
function enforcement(source) {
  if (CHECK.test(source)) return "direct";
  if (RESOURCE_CHECK.test(source)) return "resource month";
  if (RESOURCE_LISTING.test(source)) return "resource listing (per-item month locks)";
  const fn = Object.keys(ENFORCING_FUNCTIONS).find((name) => new RegExp(`\\b${name}\\(`).test(source));
  if (fn) return `via ${fn}`;
  const mod = ENFORCING_MODULES.find((file) => source.includes(`"@/${file.replace(/\.ts$/, "")}"`));
  if (mod) return `via ${mod}`;
  return null;
}

function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test("classifier: a new student content route without the check is caught; enforced and teacher routes are not", () => {
  const unprotected = 'import { requireStudentSession } from "@/lib/auth-session";\nexport async function GET() { const s = await requireStudentSession(); return load(s); }';
  assert.equal(isStudentFacing(unprotected), true);
  assert.equal(enforcement(unprotected), null);
  assert.equal(enforcement(`${unprotected}\nawait assertContentAccessForStudent(s.studentId, { lectureId });`), "direct");
  assert.equal(enforcement(`${unprotected}\nawait assertResourceAccessForStudent(s.studentId, { noteId });`), "resource month");
  assert.equal(enforcement(`${unprotected}\nconst lock = resourceLockFor(access, classId, month);`), "resource listing (per-item month locks)");
  assert.equal(enforcement('const info = await getSessionJoinInfo(id, s);'), "via getSessionJoinInfo");
  assert.equal(enforcement('import { x } from "@/services/breakout-student-quiz-service";'), "via services/breakout-student-quiz-service.ts");
  assert.equal(isStudentFacing('const t = await requireTeacherSession();'), false);
  assert.equal(isStudentFacing('const a = await requireAppSession(); if (a.role !== "TEACHER") throw x;'), false);
});

test("every student-facing API route is enforced or explicitly exempt (with a reason)", () => {
  const missing = [];
  const student = [];
  for (const rel of routeFiles()) {
    const source = read(rel);
    if (!isStudentFacing(source)) continue;
    student.push(rel);
    if (!enforcement(source) && !EXEMPT[rel]) missing.push(rel);
  }
  assert.ok(student.length >= 60, `found ${student.length} student routes`);
  assert.deepEqual(
    missing,
    [],
    `Student routes without the class access check. Protect them with assertContentAccessForStudent ` +
      `(services/class-access-service.ts) or, if intentionally reachable while a class is restricted, add them to EXEMPT with a reason:\n${missing.join("\n")}`
  );
});

test("the exemption list is exact: every entry exists, is student-facing, does not enforce, and has a reason", () => {
  for (const [rel, reason] of Object.entries(EXEMPT)) {
    assert.ok(fs.existsSync(path.join(root, rel)), `stale exemption (route gone): ${rel}`);
    const source = read(rel);
    assert.ok(isStudentFacing(source), `not a student route, remove from EXEMPT: ${rel}`);
    assert.equal(enforcement(source), null, `now enforced, remove from EXEMPT: ${rel}`);
    assert.ok(typeof reason === "string" && reason.length > 5, rel);
  }
});

test("payment and account routes are never restricted", () => {
  for (const rel of Object.keys(EXEMPT).filter((r) => /payment|profile|\/qr/.test(r))) {
    assert.doesNotMatch(read(rel), CHECK, rel);
    assert.doesNotMatch(read(rel), RESOURCE_CHECK, rel);
  }
});

test("enforcing functions and modules really make the check", () => {
  for (const [name, file] of Object.entries(ENFORCING_FUNCTIONS)) {
    assert.match(functionBody(read(file), name), CHECK, `${name} in ${file}`);
  }
  const studentAccess = read("lib/breakout-activities/student-access.ts");
  assert.match(functionBody(studentAccess, "requireEnrolledStudentSessionAccess"), CHECK);
  assert.match(functionBody(studentAccess, "lockEnrolledActiveSession"), /requireEnrolledStudentSessionAccess\(/);
  const groupAccess = read("lib/breakout-activities/groups/access.ts");
  assert.match(groupAccess, /from "\.\.\/student-access"/);
  for (const file of ENFORCING_MODULES) {
    const source = read(file);
    assert.ok(
      /from "@\/lib\/breakout-activities\/(student-access|groups\/access)"/.test(source) &&
        /requireEnrolledStudentSessionAccess|lockEnrolledActiveSession|requireStudentGroup|lockStudentGroup|findStudentGroup/.test(source),
      `${file} reaches the enrolment + access check`
    );
  }
  // Live YouTube watch links are filtered for restricted classes.
  assert.match(read("lib/youtube-live-status.ts"), /getClassAccessRestrictions\(options\.studentId\)[\s\S]{0,600}id: \{ notIn: restrictedClassIds \}/);
});
