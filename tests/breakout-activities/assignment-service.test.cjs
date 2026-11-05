/*
 * Teacher assignment service (services/breakout-assignment-service.ts):
 * ownership, the lock order and transaction options, all-or-nothing
 * creation (MAIN + BREAKOUT, one group, one brief), state changes per
 * activity, DRAFT-only edits and deletes, the instructions-or-brief rule on
 * the resulting state, explicit database-clock timestamps, brief storage and
 * cleanup, and session/assignment scoping of every read.
 *
 * Real service module; lib/prisma.ts is an in-memory fake (rolls back on
 * error) and lib/server-clock.ts a fixed clock. Files go to a temporary
 * folder under the OS temp directory. No database is contacted.
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

// ---- Fakes ------------------------------------------------------------------

let db;
let clock = new Date("2026-11-05T10:00:00.000Z");
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

const service = require(path.join(root, "services/breakout-assignment-service.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));
const { BREAKOUT_TRANSACTION_OPTIONS } = require(path.join(root, "lib/breakout-activities/locks.ts"));

const T1 = "teacher-1";
const T2 = "teacher-2";
const S1 = "6e445fc0-1c04-46bd-8dd3-82acfa381b21"; // T1, active
const S2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"; // T2, active
const S3 = "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b"; // T1, ended
const ST1 = "a1111111-1111-4111-8111-111111111111";
const ST2 = "a2222222-2222-4222-8222-222222222222";
const MAIN = { type: "MAIN" };

let storageRoot;
test.beforeEach(() => {
  clock = new Date("2026-11-05T10:00:00.000Z");
  db = createFakeBreakoutDb(); // @updatedAt fallback = an app clock far from the database clock
  db.tables.class.push({ id: "class-1", teacherId: T1 }, { id: "class-2", teacherId: T2 }, { id: "class-3", teacherId: T1 });
  db.tables.classSession.push(
    { id: S1, classId: "class-1", isActive: true },
    { id: S2, classId: "class-2", isActive: true },
    { id: S3, classId: "class-3", isActive: false }
  );
  db.tables.student.push({ id: ST1, name: "Nimal", registrationNumber: "R-1" }, { id: ST2, name: "Kamala", registrationNumber: null });
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "breakout-assignment-service-"));
});
test.afterEach(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

const pdf = (fill = 1) => {
  const bytes = new Uint8Array(64).fill(fill);
  bytes.set(Buffer.from("%PDF-1.7\n"));
  return { bytes, displayName: "Brief.pdf", sizeBytes: 64 };
};
const create = (overrides = {}, options = {}) =>
  service.createAssignments(
    { teacherId: T1, sessionId: S1, title: "Essay", instructions: "Write 200 words", targets: [MAIN], publish: false, brief: null, ...overrides },
    { storageRoot, ...options }
  );
const directory = (rooms) => ({ listBreakoutRooms: async () => rooms });
const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((n) => n.endsWith(".pdf")) : []);
const appError = (status, code) => (e) => {
  assert.ok(e instanceof AppError, String(e?.stack ?? e));
  assert.equal(e.statusCode, status);
  assert.equal(e.code, code);
  return true;
};

// ---- Create -----------------------------------------------------------------

test("create (MAIN, draft): one row, explicit database-clock createdAt, teacher from input, a group id", async () => {
  const result = await create();
  assert.equal(result.assignments.length, 1);
  const [row] = db.tables.breakoutAssignment;
  assert.equal(row.classSessionId, S1);
  assert.equal(row.teacherId, T1);
  assert.equal(row.publishGroupId, result.publishGroupId);
  assert.equal(row.targetRoomType, "MAIN");
  assert.equal(row.targetRoomId, null);
  assert.equal(row.targetRoomName, "Main room");
  assert.equal(row.state, "DRAFT");
  assert.equal(row.publishedAt, null);
  assert.equal(row.createdAt.toISOString(), clock.toISOString(), "createdAt passed explicitly");
  const created = db.calls.find((c) => c.model === "breakoutAssignment" && c.method === "create");
  assert.ok(created.args.data.createdAt, "createdAt is in the create data, not left to a default");
  assert.equal(result.assignments[0].state, "DRAFT");
});

test("every write runs in runBreakoutTransaction with the breakout options and the lock order", async () => {
  await create();
  assert.deepEqual(db.transactions, [BREAKOUT_TRANSACTION_OPTIONS]);
  assert.deepEqual(db.rawSql(), [
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR KEY SHARE',
  ]);
  const txCalls = db.calls.filter((c) => c.tx === db.lastTx());
  const firstLock = txCalls.findIndex((c) => c.kind === "raw" && /FOR KEY SHARE/.test(c.sql));
  const firstCreate = txCalls.findIndex((c) => c.method === "create");
  assert.ok(firstLock >= 0 && firstLock < firstCreate, "the session lock comes before any write");
  assert.equal(db.calls.filter((c) => c.tx === 0 && ["create", "update"].includes(c.method)).length, 0, "no write outside a transaction");
});

test("create + publish to MAIN and several BREAKOUT rooms: one group, all published at once, names from the directory", async () => {
  const result = await create(
    { targets: [MAIN, { type: "BREAKOUT", id: "r1" }, { type: "BREAKOUT", id: "r2" }], publish: true },
    { roomDirectory: directory([{ id: "r1", name: "Room One" }, { id: "r2", name: "Room Two" }]) }
  );
  const rows = db.tables.breakoutAssignment;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.targetRoomName), ["Main room", "Room One", "Room Two"]);
  assert.ok(rows.every((r) => r.publishGroupId === result.publishGroupId && r.state === "PUBLISHED"));
  assert.ok(rows.every((r) => r.publishedAt.toISOString() === clock.toISOString() && r.createdAt.toISOString() === clock.toISOString()));
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
});

test("an unresolvable BREAKOUT target refuses everything (409 ROOM_UNKNOWN): no row, MAIN included; no file", async () => {
  await assert.rejects(create({ targets: [MAIN, { type: "BREAKOUT", id: "r1" }], publish: true, brief: pdf() }), appError(409, "ROOM_UNKNOWN"));
  await assert.rejects(
    create({ targets: [MAIN, { type: "BREAKOUT", id: "r9" }] }, { roomDirectory: directory([{ id: "r1", name: "Room One" }]) }),
    appError(409, "ROOM_UNKNOWN")
  );
  assert.equal(db.tables.breakoutAssignment.length, 0);
  assert.deepEqual(filesUnder(storageRoot), [], "the brief is written only after the rooms resolved");
});

test("the brief is stored once under briefs/<publishGroupId>/ and shared by the group; its path is never returned", async () => {
  const result = await create(
    { targets: [MAIN, { type: "BREAKOUT", id: "r1" }], brief: pdf(), instructions: "" },
    { roomDirectory: directory([{ id: "r1", name: "Room One" }]) }
  );
  const rows = db.tables.breakoutAssignment;
  assert.equal(rows[0].briefFilePath, rows[1].briefFilePath);
  assert.match(rows[0].briefFilePath, new RegExp(`^breakout-activities/${S1}/briefs/${result.publishGroupId}/\\d{13}-[0-9a-f]{32}\\.pdf$`));
  assert.ok(rows[0].briefFilePath.startsWith(`breakout-activities/${S1}/briefs/${result.publishGroupId}/${clock.getTime()}-`), "named with the database clock");
  assert.equal(filesUnder(storageRoot).length, 1, "one file for the whole group");
  assert.deepEqual(result.assignments[0].brief, { fileName: "Brief.pdf", fileSize: 64 });
  assert.ok(!JSON.stringify(result).includes("breakout-activities/"), "no stored path in the response");
});

/** Runs fn with console.error captured (the expected "left for session cleanup" lines). */
async function captureErrors(fn) {
  const saved = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  try {
    await fn();
  } finally {
    console.error = saved;
  }
  return lines;
}

test("a failure after the brief was written rolls the rows back and LEAVES the file for session cleanup (F2)", async () => {
  db.failOn("breakoutAssignment.create", 2);
  const logged = await captureErrors(() =>
    assert.rejects(
      create({ targets: [MAIN, { type: "BREAKOUT", id: "r1" }], brief: pdf() }, { roomDirectory: directory([{ id: "r1", name: "Room One" }]) }),
      /injected failure/
    )
  );
  assert.equal(db.tables.breakoutAssignment.length, 0, "the first row was rolled back");
  const left = filesUnder(storageRoot);
  assert.equal(left.length, 1, "the new brief is not deleted (an ambiguous commit could still refer to it)");
  assert.ok(left[0].split(path.sep).join("/").startsWith(`breakout-activities/${S1}/briefs/`), "inside this session's folder, removed with it");
  assert.equal(logged.length, 1, "logged once");
});

test("instructions or a brief: empty instructions need a brief", async () => {
  await assert.rejects(create({ instructions: "" }), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(create({ instructions: "   " }), appError(400, "VALIDATION_ERROR"));
  assert.equal(db.transactions.length, 0, "refused before any transaction");
  await create({ instructions: "", brief: pdf() });
  assert.equal(db.tables.breakoutAssignment.length, 1);
});

test("ownership and session state: another teacher's session is 404 (active or not); own ended session 409", async () => {
  await assert.rejects(create({ sessionId: S2 }), appError(404, "SESSION_NOT_FOUND"));
  await assert.rejects(create({ teacherId: T2, sessionId: S3 }), appError(404, "SESSION_NOT_FOUND"), "never reveals that it ended");
  await assert.rejects(create({ sessionId: S3 }), appError(409, "SESSION_NOT_ACTIVE"));
  await assert.rejects(create({ sessionId: "not-a-uuid" }), appError(404, "SESSION_NOT_FOUND"));
  assert.equal(db.tables.breakoutAssignment.length, 0);
});

// ---- State changes ----------------------------------------------------------

async function draftGroup() {
  const result = await create(
    { targets: [MAIN, { type: "BREAKOUT", id: "r1" }] },
    { roomDirectory: directory([{ id: "r1", name: "Room One" }]) }
  );
  return result.assignments.map((a) => a.id);
}
const setState = (assignmentId, action, overrides = {}) => service.setAssignmentState({ teacherId: T1, sessionId: S1, assignmentId, action, ...overrides });
const row = (id) => db.tables.breakoutAssignment.find((r) => r.id === id);

test("publish then close, this activity only; timestamps from the database clock; lock order", async () => {
  const [a, b] = await draftGroup();
  clock = new Date("2026-11-05T10:05:00.000Z");
  const published = await setState(a, "publish");
  assert.equal(published.changed, true);
  assert.equal(row(a).state, "PUBLISHED");
  assert.equal(row(a).publishedAt.toISOString(), clock.toISOString());
  assert.equal(row(b).state, "DRAFT", "the rest of the group is unchanged");
  assert.deepEqual(db.rawSql(), [
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR KEY SHARE',
    'SELECT "id", "state"::text AS "state", "status" FROM "BreakoutAssignment" WHERE "id" = ? AND "classSessionId" = ? FOR UPDATE',
  ]);
  clock = new Date("2026-11-05T10:10:00.000Z");
  await setState(a, "close");
  assert.equal(row(a).state, "CLOSED");
  assert.equal(row(a).closedAt.toISOString(), clock.toISOString());
});

test("repeating the current state succeeds and changes nothing", async () => {
  const [a] = await draftGroup();
  await setState(a, "publish");
  const before = structuredClone(row(a));
  const again = await setState(a, "publish");
  assert.equal(again.changed, false);
  assert.deepEqual(row(a), before);
  await setState(a, "close");
  const closed = structuredClone(row(a));
  assert.equal((await setState(a, "close")).changed, false);
  assert.deepEqual(row(a), closed);
});

test("invalid transitions: close a DRAFT 409 ACTIVITY_NOT_PUBLISHED; publish a CLOSED 409 ASSIGNMENT_CLOSED", async () => {
  const [a] = await draftGroup();
  await assert.rejects(setState(a, "close"), appError(409, "ACTIVITY_NOT_PUBLISHED"));
  await setState(a, "publish");
  await setState(a, "close");
  await assert.rejects(setState(a, "publish"), appError(409, "ASSIGNMENT_CLOSED"));
});

test("an assignment of another session, a deleted one or an unknown id is 404", async () => {
  const [a] = await draftGroup();
  db.tables.breakoutAssignment.push({ ...structuredClone(row(a)), id: "b0000000-0000-4000-8000-000000000001", classSessionId: S2 });
  await assert.rejects(setState("b0000000-0000-4000-8000-000000000001", "publish"), appError(404, "ASSIGNMENT_NOT_FOUND"));
  await assert.rejects(setState("b0000000-0000-4000-8000-000000000002", "publish"), appError(404, "ASSIGNMENT_NOT_FOUND"));
  await assert.rejects(setState("nope", "publish"), appError(404, "ASSIGNMENT_NOT_FOUND"));
  row(a).status = 1;
  await assert.rejects(setState(a, "publish"), appError(404, "ASSIGNMENT_NOT_FOUND"));
  await assert.rejects(setState(a, "publish", { teacherId: T2 }), appError(404, "SESSION_NOT_FOUND"));
});

// ---- Edits and delete -------------------------------------------------------

const edit = (assignmentId, changes) => service.editAssignment({ teacherId: T1, sessionId: S1, assignmentId, ...changes }, { storageRoot });

test("edits: DRAFT only (PUBLISHED 409 ACTIVITY_NOT_DRAFT, CLOSED 409 ASSIGNMENT_CLOSED)", async () => {
  const [a] = await draftGroup();
  const edited = await edit(a, { title: "New title" });
  assert.equal(edited.assignment.title, "New title");
  await setState(a, "publish");
  await assert.rejects(edit(a, { title: "x" }), appError(409, "ACTIVITY_NOT_DRAFT"));
  await setState(a, "close");
  await assert.rejects(edit(a, { title: "x" }), appError(409, "ASSIGNMENT_CLOSED"));
  await assert.rejects(edit(a, {}), appError(400, "VALIDATION_ERROR"));
});

test("edits: the resulting state needs instructions or a brief", async () => {
  const [a] = await draftGroup();
  await assert.rejects(edit(a, { instructions: "" }), appError(400, "VALIDATION_ERROR"), "no brief: instructions cannot be emptied");
  assert.equal(row(a).instructions, "Write 200 words");
  await edit(a, { instructions: "", brief: pdf(2) });
  assert.equal(row(a).instructions, "");
  await edit(a, { title: "Still fine" }, "empty instructions with an existing brief");
});

test("brief replacement: stored for this assignment; the group's shared file is kept while others use it", async () => {
  const result = await create(
    { targets: [MAIN, { type: "BREAKOUT", id: "r1" }], brief: pdf(1) },
    { roomDirectory: directory([{ id: "r1", name: "Room One" }]) }
  );
  const [a, b] = result.assignments.map((x) => x.id);
  const shared = row(a).briefFilePath;
  await edit(a, { brief: pdf(2) });
  assert.match(row(a).briefFilePath, new RegExp(`^breakout-activities/${S1}/briefs/${a}/`));
  assert.equal(row(b).briefFilePath, shared, "the sibling still points to the group file");
  assert.ok(fs.existsSync(path.join(storageRoot, ...shared.split("/"))), "the shared file is kept");
  // Replacing again: the previous (own, unshared) file is removed after the commit.
  const own = row(a).briefFilePath;
  await edit(a, { brief: pdf(3) });
  assert.equal(fs.existsSync(path.join(storageRoot, ...own.split("/"))), false);
  assert.ok(fs.existsSync(path.join(storageRoot, ...row(a).briefFilePath.split("/"))));
});

test("brief replacement that fails: row unchanged, old brief kept, new file LEFT for session cleanup (F2)", async () => {
  const result = await create({ brief: pdf(1) });
  const a = result.assignments[0].id;
  const oldPath = row(a).briefFilePath;
  db.failOn("breakoutAssignment.update");
  const logged = await captureErrors(() => assert.rejects(edit(a, { brief: pdf(2) }), /injected failure/));
  assert.equal(row(a).briefFilePath, oldPath, "the row still points to the old brief");
  assert.ok(fs.existsSync(path.join(storageRoot, ...oldPath.split("/"))), "the old brief is kept (nothing committed)");
  assert.equal(filesUnder(storageRoot).length, 2, "the new file is left, unreferenced, for session cleanup");
  assert.equal(logged.length, 1);
});

test("F1: every write passes updatedAt explicitly from the database clock (never Prisma's own clock)", async () => {
  const roomDirectory = directory([{ id: "r1", name: "Room One" }]);
  const actions = [
    ["create", () => create({ targets: [MAIN, { type: "BREAKOUT", id: "r1" }], brief: pdf(1) }, { roomDirectory })],
    ["publish", () => setState(a, "publish")],
    ["close", () => setState(a, "close")],
    ["edit", () => edit(b, { title: "Edited" })],
    ["replace brief", () => edit(b, { brief: pdf(2) })],
    ["delete", () => service.deleteAssignment({ teacherId: T1, sessionId: S1, assignmentId: b })],
  ];
  let a;
  let b;
  for (const [i, [name, run]] of actions.entries()) {
    clock = new Date(Date.UTC(2026, 10, 5, 10, 1 + i));
    const result = await run();
    if (name === "create") [a, b] = result.assignments.map((x) => x.id);
    const writes = db.calls.filter((c) => c.tx === db.lastTx() && (c.method === "create" || c.method === "update"));
    assert.ok(writes.length > 0, name);
    for (const w of writes) {
      assert.ok(w.args.data.updatedAt, `${name}: updatedAt passed explicitly`);
      assert.equal(new Date(w.args.data.updatedAt).toISOString(), clock.toISOString(), `${name}: from the database clock`);
    }
  }
  for (const r of db.tables.breakoutAssignment) {
    assert.notEqual(r.updatedAt.getUTCFullYear(), 1999, "no row was left to the app clock");
  }
});

test("delete: DRAFT only, soft (status 1); then gone from lists and further changes", async () => {
  const [a, b] = await draftGroup();
  const del = (id) => service.deleteAssignment({ teacherId: T1, sessionId: S1, assignmentId: id });
  assert.deepEqual(await del(a), { id: a, status: 1 });
  assert.equal(row(a).status, 1, "the row stays (counted in the session summary)");
  await assert.rejects(del(a), appError(404, "ASSIGNMENT_NOT_FOUND"));
  await setState(b, "publish");
  await assert.rejects(del(b), appError(409, "ACTIVITY_NOT_DRAFT"));
  await setState(b, "close");
  await assert.rejects(del(b), appError(409, "ASSIGNMENT_CLOSED"));
  const list = await service.listAssignmentsForTeacher(T1, S1);
  assert.deepEqual(list.assignments.map((x) => x.id), [b]);
});

// ---- Reads ------------------------------------------------------------------

function addSubmission(assignmentId, studentId, version, isLatest, extra = {}) {
  const id = `c${String(db.tables.breakoutAssignmentSubmission.length).padStart(7, "0")}-0000-4000-8000-000000000000`;
  db.tables.breakoutAssignmentSubmission.push({
    id,
    assignmentId,
    classSessionId: S1,
    studentId,
    version,
    isLatest,
    answerText: `v${version}`,
    fileName: null,
    filePath: null,
    fileSize: null,
    idempotencyKey: `key-${id}`,
    submittedAt: new Date(Date.UTC(2026, 10, 5, 10, version)),
    ...extra,
  });
  return id;
}

test("list: the session's assignments with counts; another teacher gets 404; ended sessions still readable", async () => {
  const [a, b] = await draftGroup();
  addSubmission(a, ST1, 1, false);
  addSubmission(a, ST1, 2, true);
  addSubmission(a, ST2, 1, true);
  db.tables.breakoutAssignmentDraft.push({ id: "d1", assignmentId: a, classSessionId: S1, studentId: ST1 });
  const { assignments } = await service.listAssignmentsForTeacher(T1, S1);
  assert.deepEqual(assignments.find((x) => x.id === a).counts, { studentsSubmitted: 2, submissions: 3, drafts: 1 });
  assert.deepEqual(assignments.find((x) => x.id === b).counts, { studentsSubmitted: 0, submissions: 0, drafts: 0 });
  await assert.rejects(service.listAssignmentsForTeacher(T2, S1), appError(404, "SESSION_NOT_FOUND"));
  assert.deepEqual((await service.listAssignmentsForTeacher(T1, S3)).assignments, []);
  assert.equal(db.transactions.length, 1, "reads use no transaction");
});

test("submissions: latest per student with version count; ?studentId history; scoped to the assignment", async () => {
  const [a, b] = await draftGroup();
  addSubmission(a, ST1, 1, false);
  addSubmission(a, ST1, 2, true, { idempotencyKey: "secret-key", filePath: `breakout-activities/${S1}/submissions/x/y.pdf`, fileName: "a.pdf", fileSize: 10 });
  addSubmission(a, ST2, 1, true);
  addSubmission(b, ST1, 1, true);
  const latest = await service.listAssignmentSubmissionsForTeacher({ teacherId: T1, sessionId: S1, assignmentId: a });
  assert.equal(latest.submissions.length, 2);
  const nimal = latest.submissions.find((s) => s.student.id === ST1);
  assert.equal(nimal.version, 2);
  assert.equal(nimal.versionCount, 2);
  assert.deepEqual(nimal.student, { id: ST1, name: "Nimal", registrationNumber: "R-1" });
  assert.deepEqual(nimal.file, { fileName: "a.pdf", fileSize: 10 });
  assert.ok(!JSON.stringify(latest).includes("secret-key") && !JSON.stringify(latest).includes("breakout-activities/"));
  const history = await service.listAssignmentSubmissionsForTeacher({ teacherId: T1, sessionId: S1, assignmentId: a, studentId: ST1 });
  assert.deepEqual(history.submissions.map((s) => s.version), [2, 1]);
  await assert.rejects(
    service.listAssignmentSubmissionsForTeacher({ teacherId: T1, sessionId: S1, assignmentId: a, studentId: "bad" }),
    appError(404, "NOT_FOUND")
  );
  await assert.rejects(
    service.listAssignmentSubmissionsForTeacher({ teacherId: T2, sessionId: S1, assignmentId: a }),
    appError(404, "SESSION_NOT_FOUND")
  );
});

test("files: brief and submission PDFs, only within this assignment and session", async () => {
  const result = await create({ brief: pdf(5), instructions: "" });
  const a = result.assignments[0].id;
  const brief = await service.getAssignmentBriefForTeacher({ teacherId: T1, sessionId: S1, assignmentId: a }, { storageRoot });
  assert.equal(brief.displayName, "Brief.pdf");
  assert.equal(brief.sizeBytes, 64);
  assert.equal(brief.bytes[20], 5);

  const [noBrief] = (await create()).assignments.map((x) => x.id);
  await assert.rejects(service.getAssignmentBriefForTeacher({ teacherId: T1, sessionId: S1, assignmentId: noBrief }, { storageRoot }), appError(404, "FILE_NOT_FOUND"));

  const { writeBreakoutPdf } = require(path.join(root, "lib/breakout-activities/storage.ts"));
  const stored = await writeBreakoutPdf({ sessionId: S1, kind: "submission", activityId: a, bytes: pdf(7).bytes, storageRoot, nowMs: clock.getTime() });
  const sub = addSubmission(a, ST1, 1, true, { filePath: stored.relativePath, fileName: "answer.pdf", fileSize: 64 });
  const file = await service.getAssignmentSubmissionFileForTeacher({ teacherId: T1, sessionId: S1, assignmentId: a, submissionId: sub }, { storageRoot });
  assert.equal(file.displayName, "answer.pdf");
  assert.equal(file.bytes[20], 7);
  await assert.rejects(
    service.getAssignmentSubmissionFileForTeacher({ teacherId: T1, sessionId: S1, assignmentId: noBrief, submissionId: sub }, { storageRoot }),
    appError(404, "NOT_FOUND"),
    "a submission of another assignment"
  );
  await assert.rejects(
    service.getAssignmentSubmissionFileForTeacher({ teacherId: T2, sessionId: S1, assignmentId: a, submissionId: sub }, { storageRoot }),
    appError(404, "SESSION_NOT_FOUND")
  );
  const textOnly = addSubmission(a, ST2, 1, true);
  await assert.rejects(
    service.getAssignmentSubmissionFileForTeacher({ teacherId: T1, sessionId: S1, assignmentId: a, submissionId: textOnly }, { storageRoot }),
    appError(404, "FILE_NOT_FOUND")
  );
});
