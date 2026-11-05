/*
 * Student assignment service (services/breakout-student-assignment-service.ts):
 * the default resolver failing closed, enrolment / session (D2: all 404),
 * room matching (D6: current room only), drafts with revisions, text / PDF /
 * both submissions, versions and the single-latest invariant, idempotent
 * replay (also after close), the 20-version limit, cross-student and
 * cross-room isolation, file downloads, F2 file handling, explicit
 * timestamps, and the exact lock order.
 *
 * Real service module; lib/prisma.ts is an in-memory fake (rolls back on
 * error), lib/server-clock.ts a fixed clock, the room resolver injected.
 * Files go to a temporary folder. No database is contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeBreakoutDb } = require("./helpers/fake-breakout-db.cjs");

let db;
let clock = new Date("2026-11-06T09:00:00.000Z");
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => db.client[key] }) });
fake("lib/server-clock.ts", { serverNow: async () => new Date(clock), serverNowSync: () => new Date(clock), resetServerClock() {} });

const service = require(path.join(root, "services/breakout-student-assignment-service.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));
const { BREAKOUT_TRANSACTION_OPTIONS } = require(path.join(root, "lib/breakout-activities/locks.ts"));

const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21"; // active, class-1
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"; // active, class-2
const S3 = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b"; // ended, class-1
const ST1 = "a1111111-1111-4111-8111-111111111111"; // enrolled class-1, MAIN
const ST2 = "a2222222-2222-4222-8222-222222222222"; // enrolled class-1, room r1
const ST3 = "a3333333-3333-4333-8333-333333333333"; // not enrolled
const A = {
  MAIN: "b0000000-0000-4000-8000-000000000001",
  R1: "b0000000-0000-4000-8000-000000000002",
  R2: "b0000000-0000-4000-8000-000000000003",
  DRAFT: "b0000000-0000-4000-8000-000000000004",
  CLOSED: "b0000000-0000-4000-8000-000000000005",
  DELETED: "b0000000-0000-4000-8000-000000000006",
  OTHER_SESSION: "b0000000-0000-4000-8000-000000000007",
};

let rooms; // studentId -> room (the injected resolver)
let storageRoot;
const resolver = { resolveStudentRoom: async ({ studentId }) => rooms[studentId] ?? null };
const opts = () => ({ roomResolver: resolver, storageRoot });

function assignment(id, extra = {}) {
  return {
    id, classSessionId: S1, teacherId: "t1", publishGroupId: "g1", targetRoomType: "MAIN", targetRoomId: null, targetRoomName: "Main room",
    title: `Assignment ${id.slice(-1)}`, instructions: "Write", briefFileName: null, briefFilePath: null, briefFileSize: null,
    state: "PUBLISHED", publishedAt: clock, closedAt: null, status: 0, createdAt: new Date(clock.getTime() + Number(id.slice(-1))), updatedAt: clock, ...extra,
  };
}

test.beforeEach(() => {
  clock = new Date("2026-11-06T09:00:00.000Z");
  rooms = { [ST1]: { type: "MAIN" }, [ST2]: { type: "BREAKOUT", id: "r1" } };
  db = createFakeBreakoutDb();
  db.tables.class.push({ id: "class-1", teacherId: "t1" }, { id: "class-2", teacherId: "t1" });
  db.tables.classSession.push({ id: S1, classId: "class-1", isActive: true }, { id: S2, classId: "class-2", isActive: true }, { id: S3, classId: "class-1", isActive: false });
  db.tables.student.push({ id: ST1, status: 0 }, { id: ST2, status: 0 }, { id: ST3, status: 0 });
  db.tables.classStudent.push({ studentId: ST1, classId: "class-1", isActive: true }, { studentId: ST2, classId: "class-1", isActive: true });
  db.tables.breakoutAssignment.push(
    assignment(A.MAIN),
    assignment(A.R1, { targetRoomType: "BREAKOUT", targetRoomId: "r1", targetRoomName: "Room 1" }),
    assignment(A.R2, { targetRoomType: "BREAKOUT", targetRoomId: "r2", targetRoomName: "Room 2" }),
    assignment(A.DRAFT, { state: "DRAFT", publishedAt: null }),
    assignment(A.CLOSED, { state: "CLOSED", closedAt: clock }),
    assignment(A.DELETED, { status: 1 }),
    assignment(A.OTHER_SESSION, { classSessionId: S2 })
  );
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "breakout-student-assignment-"));
});
test.afterEach(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

const appError = (status, code) => (e) => {
  assert.ok(e instanceof AppError, String(e?.stack ?? e));
  assert.equal(e.statusCode, status, `${e.code}: ${e.message}`);
  assert.equal(e.code, code);
  return true;
};
const pdf = (fill = 1, size = 64) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(Buffer.from("%PDF-1.7\n"));
  return { bytes, fileName: "Answer.pdf", mimeType: "application/pdf" };
};
const pdfFiles = () => (fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot, { recursive: true }).filter((n) => String(n).endsWith(".pdf")) : []);
let keySeq = 0;
const key = () => `key-${++keySeq}`;
const saveDraft = (extra = {}, o = opts()) =>
  service.saveDraftForStudent({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN, revision: 0, answerText: "My draft", ...extra }, o);
const submit = (extra = {}, o = opts()) =>
  service.submitAssignmentForStudent({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN, answerText: "My answer", file: null, idempotencyKey: key(), ...extra }, o);
const subs = (assignmentId = A.MAIN, studentId = ST1) => db.tables.breakoutAssignmentSubmission.filter((s) => s.assignmentId === assignmentId && s.studentId === studentId);

// ---- Fail closed, enrolment, session ------------------------------------------

test("the DEFAULT resolver fails closed: every read and write is 404, nothing written", async () => {
  const ids = { studentId: ST1, sessionId: S1, assignmentId: A.MAIN };
  const noResolver = { storageRoot };
  const calls = [
    () => service.listAssignmentsForStudent({ studentId: ST1, sessionId: S1 }, noResolver),
    () => service.getAssignmentBriefForStudent(ids, noResolver),
    () => service.getDraftForStudent(ids, noResolver),
    () => service.listOwnSubmissions(ids, noResolver),
    () => service.getOwnSubmissionFile({ ...ids, submissionId: A.R1 }, noResolver),
    () => saveDraft({}, noResolver),
    () => submit({}, noResolver),
  ];
  for (const call of calls) await assert.rejects(call(), appError(404, "NOT_FOUND"));
  assert.equal(db.tables.breakoutAssignmentDraft.length + db.tables.breakoutAssignmentSubmission.length, 0);
});

test("D2: not enrolled, ended session, other session, inactive enrolment: the same 404 for reads and writes", async () => {
  db.tables.classStudent.push({ studentId: ST3, classId: "class-2", isActive: true });
  rooms[ST3] = { type: "MAIN" };
  const cases = [
    { studentId: ST3, sessionId: S1 }, // not enrolled in class-1
    { studentId: ST1, sessionId: S3 }, // ended
    { studentId: ST1, sessionId: S2 }, // not enrolled in class-2
  ];
  for (const c of cases) {
    await assert.rejects(service.listAssignmentsForStudent(c, opts()), appError(404, "NOT_FOUND"));
    await assert.rejects(service.getDraftForStudent({ ...c, assignmentId: A.MAIN }, opts()), appError(404, "NOT_FOUND"));
    await assert.rejects(saveDraft(c), appError(404, "NOT_FOUND"));
    await assert.rejects(submit(c), appError(404, "NOT_FOUND"));
  }
  db.tables.classStudent[0].isActive = false;
  await assert.rejects(submit(), appError(404, "NOT_FOUND"));
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 0);
});

// ---- Room matching (D6) --------------------------------------------------------

test("list: only PUBLISHED / CLOSED, non-deleted assignments of the student's CURRENT room in this session", async () => {
  const main = await service.listAssignmentsForStudent({ studentId: ST1, sessionId: S1 }, opts());
  assert.deepEqual(main.room, { type: "MAIN" });
  assert.deepEqual(main.assignments.map((a) => a.id), [A.MAIN, A.CLOSED]);
  const r1 = await service.listAssignmentsForStudent({ studentId: ST2, sessionId: S1 }, opts());
  assert.deepEqual(r1.assignments.map((a) => a.id), [A.R1]);
  rooms[ST2] = { type: "BREAKOUT", id: "r2" };
  const r2 = await service.listAssignmentsForStudent({ studentId: ST2, sessionId: S1 }, opts());
  assert.deepEqual(r2.assignments.map((a) => a.id), [A.R2], "after moving rooms, the previous room is hidden");
  assert.ok(!JSON.stringify(main).includes("r1") && !JSON.stringify(main).includes("teacherId"));
});

test("an assignment of another room, a DRAFT, a deleted one or another session's is 404 everywhere", async () => {
  for (const assignmentId of [A.R1, A.R2, A.DRAFT, A.DELETED, A.OTHER_SESSION, "f0000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const ids = { studentId: ST1, sessionId: S1, assignmentId };
    await assert.rejects(service.getDraftForStudent(ids, opts()), appError(404, "ASSIGNMENT_NOT_FOUND"), assignmentId);
    await assert.rejects(service.getAssignmentBriefForStudent(ids, opts()), appError(404, "ASSIGNMENT_NOT_FOUND"));
    await assert.rejects(service.listOwnSubmissions(ids, opts()), appError(404, "ASSIGNMENT_NOT_FOUND"));
    await assert.rejects(saveDraft({ assignmentId }), appError(404, "ASSIGNMENT_NOT_FOUND"));
    await assert.rejects(submit({ assignmentId }), appError(404, "ASSIGNMENT_NOT_FOUND"));
  }
  assert.equal(db.tables.breakoutAssignmentSubmission.length + db.tables.breakoutAssignmentDraft.length, 0);
});

test("the room is resolved again inside each write: moving rooms after a read refuses the write", async () => {
  await service.getDraftForStudent({ studentId: ST2, sessionId: S1, assignmentId: A.R1 }, opts());
  rooms[ST2] = { type: "BREAKOUT", id: "r2" };
  await assert.rejects(submit({ studentId: ST2, assignmentId: A.R1 }), appError(404, "ASSIGNMENT_NOT_FOUND"));
  rooms[ST2] = null;
  await assert.rejects(submit({ studentId: ST2, assignmentId: A.R1 }), appError(404, "NOT_FOUND"), "room unknown");
});

// ---- Drafts --------------------------------------------------------------------

test("drafts: empty at revision 0, created at 1, updated with the revision seen; explicit timestamps", async () => {
  assert.deepEqual((await service.getDraftForStudent({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN }, opts())).draft, { answerText: "", revision: 0, updatedAt: null });
  const first = await saveDraft({ revision: 0, answerText: "First" });
  assert.deepEqual(first.draft, { answerText: "First", revision: 1, updatedAt: clock.toISOString() });
  clock = new Date("2026-11-06T09:05:00.000Z");
  const second = await saveDraft({ revision: 1, answerText: "Second" });
  assert.equal(second.draft.revision, 2);
  const [row] = db.tables.breakoutAssignmentDraft;
  assert.equal(row.studentId, ST1);
  assert.equal(row.classSessionId, S1);
  assert.equal(row.createdAt.toISOString(), "2026-11-06T09:00:00.000Z");
  assert.equal(row.updatedAt.toISOString(), clock.toISOString(), "updatedAt from the database clock, not the app clock");
  const writes = db.calls.filter((c) => c.model === "breakoutAssignmentDraft" && ["create", "update"].includes(c.method));
  assert.ok(writes.every((w) => w.args.data.updatedAt), "updatedAt passed explicitly on every draft write");
});

test("drafts: a stale revision is 409 REVISION_CONFLICT with the current text; limits; CLOSED keeps the draft", async () => {
  await saveDraft({ revision: 0, answerText: "Saved" });
  await assert.rejects(saveDraft({ revision: 0, answerText: "Other tab" }), (e) => {
    appError(409, "REVISION_CONFLICT")(e);
    assert.deepEqual(e.details, { answerText: "Saved", revision: 1 });
    return true;
  });
  await assert.rejects(saveDraft({ revision: 5 }), appError(409, "REVISION_CONFLICT"));
  await assert.rejects(saveDraft({ revision: -1 }), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(saveDraft({ revision: 1, answerText: "x".repeat(50_001) }), appError(400, "ANSWER_TEXT_TOO_LONG"));
  await saveDraft({ revision: 1, answerText: "x".repeat(50_000) });
  await assert.rejects(saveDraft({ assignmentId: A.CLOSED }), appError(409, "ASSIGNMENT_CLOSED"));
  assert.equal(db.tables.breakoutAssignmentDraft.length, 1);
});

test("draft save: exact lock order and the breakout transaction options", async () => {
  await saveDraft();
  assert.deepEqual(db.transactions, [BREAKOUT_TRANSACTION_OPTIONS]);
  const order = db.calls.filter((c) => c.tx === db.lastTx()).map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*FOR KEY SHARE$/, " … FOR KEY SHARE") : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" … FOR KEY SHARE',
    "student.findFirst",
    'SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutAssignment" … FOR KEY SHARE',
    "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
    "breakoutAssignmentDraft.findFirst",
    "breakoutAssignmentDraft.create",
  ]);
});

// ---- Submissions ---------------------------------------------------------------

test("submissions: text only, PDF only, both; versions 1..n; one latest; files stored per assignment", async () => {
  const text = await submit({ answerText: "Text only" });
  assert.equal(text.submission.version, 1);
  assert.equal(text.submission.file, null);
  const pdfOnly = await submit({ answerText: null, file: pdf(2) });
  assert.equal(pdfOnly.submission.version, 2);
  assert.equal(pdfOnly.submission.answerText, null);
  assert.deepEqual(pdfOnly.submission.file, { fileName: "Answer.pdf", fileSize: 64 });
  const both = await submit({ answerText: "  With file  ", file: pdf(3) });
  assert.equal(both.submission.version, 3);
  const rows = subs();
  assert.deepEqual(rows.map((r) => [r.version, r.isLatest]), [[1, false], [2, false], [3, true]]);
  assert.match(rows[2].filePath, new RegExp(`^breakout-activities/${S1}/submissions/${A.MAIN}/${clock.getTime()}-`));
  assert.equal(pdfFiles().length, 2);
  assert.ok(rows.every((r) => r.submittedAt.toISOString() === clock.toISOString() && !("updatedAt" in r)), "explicit submittedAt; no updatedAt column");
  const creates = db.calls.filter((c) => c.model === "breakoutAssignmentSubmission" && c.method === "create");
  assert.ok(creates.every((c) => c.args.data.submittedAt && !("updatedAt" in c.args.data)));
  assert.ok(!JSON.stringify(both).includes("breakout-activities/") && !JSON.stringify(both).includes("key-"), "no path or idempotency key");
});

test("submissions: empty, whitespace-only, too long, bad PDF, oversized PDF, bad key: refused, nothing written", async () => {
  await assert.rejects(submit({ answerText: null }), appError(400, "SUBMISSION_EMPTY"));
  await assert.rejects(submit({ answerText: "   \n" }), appError(400, "SUBMISSION_EMPTY"));
  await assert.rejects(submit({ answerText: "x".repeat(50_001) }), appError(400, "ANSWER_TEXT_TOO_LONG"));
  await assert.rejects(submit({ idempotencyKey: "has spaces" }), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(submit({ idempotencyKey: "" }), appError(400, "VALIDATION_ERROR"));
  const saved = console.error;
  console.error = () => {};
  try {
    await assert.rejects(submit({ file: { bytes: Buffer.from("<html>"), fileName: "x.pdf", mimeType: "application/pdf" } }), appError(400, "INVALID_PDF"));
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(Buffer.from("%PDF-1.7"));
    await assert.rejects(submit({ file: { bytes: big, fileName: "big.pdf", mimeType: "application/pdf" } }), appError(413, "FILE_TOO_LARGE"));
  } finally {
    console.error = saved;
  }
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 0);
  assert.deepEqual(pdfFiles(), []);
  await submit({ answerText: "x".repeat(50_000) });
});

test("submitted text becomes the draft text (revision + 1); a PDF-only submission leaves the draft", async () => {
  await saveDraft({ revision: 0, answerText: "Draft" });
  await submit({ answerText: "Final answer" });
  let [draft] = db.tables.breakoutAssignmentDraft;
  assert.equal(draft.answerText, "Final answer");
  assert.equal(draft.revision, 2);
  await submit({ answerText: null, file: pdf() });
  [draft] = db.tables.breakoutAssignmentDraft;
  assert.equal(draft.answerText, "Final answer");
  assert.equal(draft.revision, 2);
});

test("submit: exact lock order (session, enrolment, assignment share, advisory, then the writes)", async () => {
  await submit({ answerText: "A", file: pdf() });
  const order = db.calls.filter((c) => c.tx === db.lastTx()).map((c) => (c.kind === "raw" ? c.sql.replace(/ WHERE .*FOR KEY SHARE$/, " … FOR KEY SHARE") : `${c.model}.${c.method}`));
  assert.deepEqual(order, [
    "classSession.findFirst",
    "student.findFirst",
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" … FOR KEY SHARE',
    "student.findFirst",
    'SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutAssignment" … FOR KEY SHARE',
    "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
    "breakoutAssignmentSubmission.findFirst", // idempotency
    "breakoutAssignmentSubmission.findMany", // existing versions
    "breakoutAssignmentSubmission.updateMany", // isLatest flip
    "breakoutAssignmentSubmission.create",
    "breakoutAssignmentDraft.findFirst",
    "breakoutAssignmentDraft.create",
  ]);
  const advisory = db.calls.find((c) => c.tx === db.lastTx() && /pg_advisory_xact_lock/.test(c.sql ?? ""));
  assert.deepEqual(advisory.values, [`breakout-submission:${A.MAIN}:${ST1}`]);
});

test("idempotent replay: same key returns the original, no new version or file; also after close and at the limit", async () => {
  const first = await submit({ idempotencyKey: "retry-1", file: pdf() });
  assert.equal(first.replayed, false);
  const again = await submit({ idempotencyKey: "retry-1", file: pdf(9), answerText: "different body" });
  assert.equal(again.replayed, true);
  assert.equal(again.submission.replayed, true);
  assert.equal(again.submission.id, first.submission.id);
  assert.equal(subs().length, 1);
  assert.equal(pdfFiles().length, 1, "no second file");
  db.tables.breakoutAssignment.find((a) => a.id === A.MAIN).state = "CLOSED";
  assert.equal((await submit({ idempotencyKey: "retry-1" })).submission.id, first.submission.id, "replay after close");
  await assert.rejects(submit({ idempotencyKey: "new-key" }), appError(409, "ASSIGNMENT_CLOSED"));
});

test("20-version limit: the 21st is 409 SUBMISSION_LIMIT_REACHED; a replay still works", async () => {
  for (let i = 1; i <= 20; i += 1) await submit({ idempotencyKey: `k${i}`, answerText: `v${i}` });
  assert.equal(subs().length, 20);
  await assert.rejects(submit({ idempotencyKey: "k21" }), appError(409, "SUBMISSION_LIMIT_REACHED"));
  assert.equal((await submit({ idempotencyKey: "k20" })).replayed, true);
  assert.equal(subs().filter((s) => s.isLatest).length, 1);
  assert.equal(subs().find((s) => s.isLatest).version, 20);
});

test("a broken single-latest state is refused (never extended); the database index is the backstop", async () => {
  await submit({ idempotencyKey: "a" });
  db.tables.breakoutAssignmentSubmission.push({ ...structuredClone(subs()[0]), id: "c0000000-0000-4000-8000-00000000dup1", version: 2, idempotencyKey: "b" });
  await assert.rejects(submit({ idempotencyKey: "c" }), /Expected exactly one latest submission/);
  assert.equal(subs().length, 2, "nothing added");
});

test("F2: a failed submission rolls back the rows (flip included) but LEAVES the new PDF for session cleanup", async () => {
  await submit({ idempotencyKey: "ok" });
  db.failOn("breakoutAssignmentSubmission.create");
  const saved = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  try {
    await assert.rejects(submit({ idempotencyKey: "fails", file: pdf() }), /injected failure/);
  } finally {
    console.error = saved;
  }
  assert.deepEqual(subs().map((s) => [s.version, s.isLatest]), [[1, true]], "the isLatest flip was rolled back");
  assert.equal(pdfFiles().length, 1, "the written PDF is left (F2)");
  assert.equal(lines.length, 1, "logged once");
});

// ---- Own work only -------------------------------------------------------------

test("cross-student: history, list and files show only the student's own work", async () => {
  rooms[ST2] = { type: "MAIN" };
  const mine = await submit({ file: pdf(1) });
  await submit({ studentId: ST2, answerText: "Theirs", file: pdf(2) });
  // Their text submission already created their draft at revision 1.
  await saveDraft({ studentId: ST2, revision: 1, answerText: "Their draft" });

  const history = await service.listOwnSubmissions({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN }, opts());
  assert.deepEqual(history.submissions.map((s) => s.id), [mine.submission.id]);
  const list = await service.listAssignmentsForStudent({ studentId: ST1, sessionId: S1 }, opts());
  const item = list.assignments.find((a) => a.id === A.MAIN);
  assert.equal(item.mine.latestSubmission.id, mine.submission.id);
  assert.equal(item.mine.draft.revision, 1, "own draft (synced from the submission), not the other student's");
  assert.equal((await service.getDraftForStudent({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN }, opts())).draft.answerText, "My answer");

  const theirs = subs(A.MAIN, ST2)[0];
  await assert.rejects(
    service.getOwnSubmissionFile({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN, submissionId: theirs.id }, opts()),
    appError(404, "NOT_FOUND")
  );
  const own = await service.getOwnSubmissionFile({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN, submissionId: mine.submission.id }, opts());
  assert.equal(own.bytes[20], 1);
  assert.equal(own.displayName, "Answer.pdf");
});

test("files: brief of a visible assignment; own text-only submission has no file (404); another room's brief is 404", async () => {
  const { writeBreakoutPdf } = require(path.join(root, "lib/breakout-activities/storage.ts"));
  const stored = await writeBreakoutPdf({ sessionId: S1, kind: "brief", activityId: "a0000000-0000-4000-8000-000000000001", bytes: pdf(4).bytes, storageRoot, nowMs: clock.getTime() });
  Object.assign(db.tables.breakoutAssignment.find((a) => a.id === A.MAIN), { briefFileName: "Brief.pdf", briefFilePath: stored.relativePath, briefFileSize: 64 });
  Object.assign(db.tables.breakoutAssignment.find((a) => a.id === A.R1), { briefFileName: "R1.pdf", briefFilePath: stored.relativePath, briefFileSize: 64 });
  const brief = await service.getAssignmentBriefForStudent({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN }, opts());
  assert.equal(brief.displayName, "Brief.pdf");
  assert.equal(brief.bytes[20], 4);
  await assert.rejects(service.getAssignmentBriefForStudent({ studentId: ST1, sessionId: S1, assignmentId: A.R1 }, opts()), appError(404, "ASSIGNMENT_NOT_FOUND"));
  const textOnly = await submit({ answerText: "No file" });
  await assert.rejects(
    service.getOwnSubmissionFile({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN, submissionId: textOnly.submission.id }, opts()),
    appError(404, "FILE_NOT_FOUND")
  );
  await assert.rejects(
    service.getOwnSubmissionFile({ studentId: ST1, sessionId: S1, assignmentId: A.MAIN, submissionId: "bad" }, opts()),
    appError(404, "NOT_FOUND")
  );
});

test("CLOSED assignments stay readable (own work) but take no new drafts or submissions", async () => {
  const ids = { studentId: ST1, sessionId: S1, assignmentId: A.CLOSED };
  assert.equal((await service.getDraftForStudent(ids, opts())).draft.revision, 0);
  assert.deepEqual((await service.listOwnSubmissions(ids, opts())).submissions, []);
  await assert.rejects(submit({ assignmentId: A.CLOSED }), appError(409, "ASSIGNMENT_CLOSED"));
  await assert.rejects(saveDraft({ assignmentId: A.CLOSED }), appError(409, "ASSIGNMENT_CLOSED"));
});

// ---- Idempotent retry before content validation (Stage 3.1 correction) -------

test("retry with an existing key returns the ORIGINAL whatever the body: empty, too long, invalid PDF, different", async () => {
  const original = await submit({ idempotencyKey: "lost-response", answerText: "Original", file: pdf(5) });
  const before = { versions: subs().length, files: pdfFiles().length };
  const retries = [
    ["empty", { answerText: null, file: null }],
    ["whitespace only", { answerText: "   ", file: null }],
    ["text over 50,000", { answerText: "x".repeat(50_001), file: null }],
    ["invalid PDF bytes", { answerText: null, file: { bytes: Buffer.from("<html>not a pdf</html>"), fileName: "x.pdf", mimeType: "application/pdf" } }],
    ["wrong MIME type", { answerText: null, file: { ...pdf(6), mimeType: "text/html" } }],
    ["empty file", { answerText: null, file: { bytes: new Uint8Array(0), fileName: "e.pdf", mimeType: "application/pdf" } }],
    ["different valid body", { answerText: "Completely different", file: pdf(7) }],
  ];
  for (const [label, body] of retries) {
    const res = await submit({ idempotencyKey: "lost-response", ...body });
    assert.equal(res.replayed, true, label);
    assert.equal(res.submission.replayed, true, label);
    assert.equal(res.submission.id, original.submission.id, label);
    assert.equal(res.submission.answerText, "Original", `${label}: the original content`);
    assert.deepEqual(res.submission.file, { fileName: "Answer.pdf", fileSize: 64 }, label);
  }
  assert.equal(subs().length, before.versions, "no new version");
  assert.equal(pdfFiles().length, before.files, "no new file written");
  const writes = db.calls.filter((c) => c.model === "breakoutAssignmentSubmission" && ["create", "updateMany"].includes(c.method));
  assert.equal(writes.length, 2, "only the original's flip + insert ever wrote");
});

test("replay happens before content validation: the lookup is the first thing after the locks", async () => {
  await submit({ idempotencyKey: "k-order" });
  await submit({ idempotencyKey: "k-order", answerText: null });
  const order = db.calls.filter((c) => c.tx === db.lastTx()).map((c) => (c.kind === "raw" ? c.sql.slice(0, 40) : `${c.model}.${c.method}`));
  const lookup = order.lastIndexOf("breakoutAssignmentSubmission.findFirst");
  const advisory = order.findIndex((o) => o.startsWith("SELECT pg_advisory_xact_lock"));
  assert.ok(advisory >= 0 && lookup === advisory + 1, "the lookup directly follows the advisory lock");
  assert.equal(order.at(-1), "breakoutAssignmentSubmission.findFirst", "and nothing after it for a replay");
});

test("a NEW key with the same invalid contents still gets the validation error (after the lookup), nothing written", async () => {
  const cases = [
    [{ answerText: null, file: null }, 400, "SUBMISSION_EMPTY"],
    [{ answerText: "   ", file: null }, 400, "SUBMISSION_EMPTY"],
    [{ answerText: "x".repeat(50_001), file: null }, 400, "ANSWER_TEXT_TOO_LONG"],
    [{ answerText: null, file: { bytes: Buffer.from("<html>"), fileName: "x.pdf", mimeType: "application/pdf" } }, 400, "INVALID_PDF"],
    [{ answerText: null, file: { ...pdf(), mimeType: "text/html" } }, 400, "INVALID_PDF"],
    [{ answerText: "ok", file: { bytes: new Uint8Array(0), fileName: "e.pdf", mimeType: "application/pdf" } }, 400, "INVALID_PDF"],
  ];
  for (const [body, status, code] of cases) {
    await assert.rejects(submit({ idempotencyKey: key(), ...body }), appError(status, code), code);
    const txCalls = db.calls.filter((c) => c.tx === db.lastTx());
    assert.ok(txCalls.some((c) => c.model === "breakoutAssignmentSubmission" && c.method === "findFirst"), `${code}: the lookup ran first`);
  }
  assert.equal(db.tables.breakoutAssignmentSubmission.length, 0);
  assert.deepEqual(pdfFiles(), []);
});

test("request checks stay BEFORE the lookup and any lock: oversized file 413, bad key 400, bad field types 400", async () => {
  await submit({ idempotencyKey: "exists" });
  const txBefore = db.transactions.length;
  const big = new Uint8Array(25 * 1024 * 1024 + 1);
  big.set(Buffer.from("%PDF-1.7"));
  await assert.rejects(submit({ idempotencyKey: "exists", file: { bytes: big, fileName: "big.pdf", mimeType: "application/pdf" } }), appError(413, "FILE_TOO_LARGE"));
  for (const badKey of ["", "has spaces", "x".repeat(65), undefined, 42]) {
    await assert.rejects(submit({ idempotencyKey: badKey }), appError(400, "VALIDATION_ERROR"), String(badKey));
  }
  await assert.rejects(submit({ answerText: 42 }), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(submit({ file: { bytes: "not bytes", fileName: "x.pdf", mimeType: "application/pdf" } }), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(submit({ file: { bytes: pdf().bytes } }), appError(400, "VALIDATION_ERROR"), "missing name / type");
  await assert.rejects(submit({ assignmentId: "bad" }), appError(404, "ASSIGNMENT_NOT_FOUND"));
  assert.equal(db.transactions.length, txBefore, "no transaction (so no lock) was started for any of them");
  // Exactly 25 MiB is allowed.
  const max = new Uint8Array(25 * 1024 * 1024);
  max.set(Buffer.from("%PDF-1.7"));
  assert.equal((await submit({ file: { bytes: max, fileName: "max.pdf", mimeType: "application/pdf" } })).submission.version, 2);
});

test("a replay still needs normal access: another student, another room or an ended session cannot replay a key", async () => {
  await submit({ idempotencyKey: "mine-only" });
  rooms[ST2] = { type: "MAIN" };
  const theirs = await submit({ studentId: ST2, idempotencyKey: "mine-only" });
  assert.equal(theirs.replayed, false, "the same key by another student is THEIR first submission");
  assert.notEqual(theirs.submission.id, subs()[0].id);
  rooms[ST1] = { type: "BREAKOUT", id: "r1" };
  await assert.rejects(submit({ idempotencyKey: "mine-only" }), appError(404, "ASSIGNMENT_NOT_FOUND"), "previous room hidden");
  rooms[ST1] = { type: "MAIN" };
  db.tables.classSession.find((s) => s.id === S1).isActive = false;
  await assert.rejects(submit({ idempotencyKey: "mine-only" }), appError(404, "NOT_FOUND"));
});

test("an idempotent replay does not modify the existing draft (content, revision, updatedAt)", async () => {
  await saveDraft({ revision: 0, answerText: "Working draft" });
  await submit({ idempotencyKey: "draft-replay", answerText: "Submitted text" });
  await saveDraft({ revision: 2, answerText: "Edited after submitting" });
  const before = structuredClone(db.tables.breakoutAssignmentDraft.find((d) => d.studentId === ST1 && d.assignmentId === A.MAIN));
  assert.equal(before.revision, 3);
  const draftWrites = () => db.calls.filter((c) => c.model === "breakoutAssignmentDraft" && ["create", "update", "updateMany"].includes(c.method)).length;
  const writesBefore = draftWrites();

  clock = new Date("2026-11-06T10:30:00.000Z");
  for (const body of [{ answerText: "Different text" }, { answerText: null }, { answerText: "x".repeat(50_001) }]) {
    const res = await submit({ idempotencyKey: "draft-replay", ...body });
    assert.equal(res.replayed, true);
  }
  const after = db.tables.breakoutAssignmentDraft.find((d) => d.studentId === ST1 && d.assignmentId === A.MAIN);
  assert.deepEqual(after, before, "draft text, revision and updatedAt unchanged");
  assert.equal(draftWrites(), writesBefore, "no draft write from any replay");
});
