/*
 * The default lecture (Lecture.isDefault, lib/default-lecture.ts):
 *  - class creation creates exactly one, atomically with the class
 *    (services/class-service.ts createClassForTeacher); editing a class never
 *    creates one;
 *  - normal lecture creation never creates one (the request schemas strip
 *    isDefault; the service never sets it: the column default, false);
 *  - the lecture service hides it from lists and refuses it in every normal
 *    single-lecture workflow (404), except the note workflow;
 *  - a static guard: every Lecture list / count query in app/, services/ and
 *    lib/ excludes it; single-row lookups without the filter are reviewed.
 *
 *   npm run test:lectures
 *
 * Faked edges: Prisma (a small in-memory Class / Lecture store whose
 * $transaction rolls back on error), session events, the fee-waiver hooks.
 * No database (the unique index: tests/lectures/default-lecture.db.test.cjs).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const TEACHER = "teacher-1";
const OTHER = "teacher-2";
const CLASS = "11111111-1111-4111-8111-111111111111";
const NORMAL = "22222222-2222-4222-8222-222222222222";
const DEFAULT = "33333333-3333-4333-8333-333333333333";

// ---- In-memory store ------------------------------------------------------------------------------

let store;
let calls;
let failLectureCreate = false;
let seq = 0;

function reset() {
  seq = 0;
  failLectureCreate = false;
  calls = [];
  store = {
    classes: { [CLASS]: { id: CLASS, teacherId: TEACHER, status: 0, name: "Physics", schedule: "Mon", monthlyFee: 1000 } },
    lectures: {
      [NORMAL]: { id: NORMAL, classId: CLASS, title: "Kinematics", date: new Date("2026-11-10T03:30:00Z"), endDate: null, classStatus: "SCHEDULED", status: 0, isDefault: false, createdAt: new Date("2026-11-01T00:00:00Z") },
      [DEFAULT]: { id: DEFAULT, classId: CLASS, title: "General Notes", date: new Date("2026-10-01T00:00:00Z"), endDate: null, classStatus: "SCHEDULED", status: 0, isDefault: true, createdAt: new Date("2026-10-01T00:00:00Z") },
    },
  };
}

const LECTURE_KEYS = new Set(["id", "classId", "status", "isDefault", "class", "title", "date"]);
function lectureMatches(l, where = {}) {
  for (const key of Object.keys(where)) if (!LECTURE_KEYS.has(key)) throw new Error(`fake: unsupported lecture filter ${key}`);
  const cls = store.classes[l.classId];
  if (where.id !== undefined && l.id !== where.id) return false;
  if (where.classId !== undefined && l.classId !== where.classId) return false;
  if (where.status !== undefined && l.status !== where.status) return false;
  if (where.isDefault !== undefined && l.isDefault !== where.isDefault) return false;
  if (where.class) {
    if (where.class.teacherId !== undefined && cls.teacherId !== where.class.teacherId) return false;
    if (where.class.status !== undefined && cls.status !== where.class.status) return false;
  }
  return true;
}

function project(l, select) {
  if (!select) return { ...l };
  const out = {};
  for (const [key, on] of Object.entries(select)) {
    if (!on) continue;
    if (key === "class") out.class = { ...store.classes[l.classId] };
    else if (key === "_count") out._count = { notes: 0, assignments: 0, quizzes: 0, whiteboards: 0 };
    else out[key] = l[key];
  }
  return out;
}

function client() {
  return {
    class: {
      create: async ({ data }) => {
        calls.push("class.create");
        const id = `new-class-${++seq}`;
        store.classes[id] = { id, teacherId: data.teacherId, status: 0, name: data.name, schedule: data.schedule, monthlyFee: data.monthlyFee };
        return { id, name: data.name };
      },
      findFirst: async ({ where }) => {
        const c = store.classes[where.id];
        return c && c.teacherId === where.teacherId && (where.status === undefined || c.status === where.status) ? { ...c } : null;
      },
    },
    lecture: {
      create: async ({ data }) => {
        calls.push(["lecture.create", data]);
        if (failLectureCreate) throw new Error("simulated failure: Lecture.create");
        // The partial unique index "Lecture_one_default_per_class".
        if (data.isDefault === true && Object.values(store.lectures).some((l) => l.classId === data.classId && l.isDefault)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `new-lecture-${++seq}`, endDate: null, classStatus: "SCHEDULED", status: 0, isDefault: false, createdAt: new Date(), ...data };
        store.lectures[row.id] = row;
        return { id: row.id, title: row.title, date: row.date, endDate: row.endDate, classStatus: row.classStatus, createdAt: row.createdAt };
      },
      findFirst: async ({ where, select }) => {
        const l = Object.values(store.lectures).find((row) => lectureMatches(row, where));
        return l ? project(l, select) : null;
      },
      findMany: async ({ where, select }) => Object.values(store.lectures).filter((row) => lectureMatches(row, where)).map((l) => project(l, select)),
      count: async ({ where }) => Object.values(store.lectures).filter((row) => lectureMatches(row, where)).length,
      update: async ({ where, data, select }) => {
        calls.push(["lecture.update", where, data]);
        const l = Object.values(store.lectures).find((row) => lectureMatches(row, where));
        if (!l) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        Object.assign(l, data);
        return project(l, select);
      },
    },
  };
}

const prismaFake = {
  ...client(),
  // An interactive transaction: on any error, every change it made is rolled back.
  $transaction: async (fn) => {
    calls.push("$transaction");
    const snapshot = structuredClone(store);
    try {
      return await fn(client());
    } catch (error) {
      store = snapshot;
      throw error;
    }
  },
};
fake("lib/prisma.ts", {
  prisma: new Proxy(prismaFake, {
    get: (target, key) => {
      if (key in target) return target[key];
      throw new Error(`unexpected Prisma access: ${String(key)}`);
    },
  }),
});
fake("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });
fake("services/fee-waiver-events.ts", { readLectureWaiverState: async () => null, recalculateAfterLectureChange: async () => {} });

const classService = require(path.join(root, "services", "class-service.ts"));
const lectureService = require(path.join(root, "services", "lecture-service.ts"));
const { createLectureSchema, updateLectureSchema } = require(path.join(root, "lib", "lecture-validation.ts"));
const { DEFAULT_LECTURE_TITLE, NORMAL_LECTURE_WHERE, defaultLectureData } = require(path.join(root, "lib", "default-lecture.ts"));

const CLASS_INPUT = { name: "Chemistry", monthlyFee: 1500, paymentDueWeek: 1, startDate: "2026-12-01", schedules: [{ dayOfWeek: "MONDAY", startTime: "08:00", endTime: "10:00" }] };
const defaultsOf = (classId) => Object.values(store.lectures).filter((l) => l.classId === classId && l.isDefault === true);

// ======================================================================================
// Class creation
// ======================================================================================

test("new class: exactly one default lecture, in the same transaction, with valid columns", async () => {
  reset();
  const before = Date.now();
  const created = await classService.createClassForTeacher(TEACHER, CLASS_INPUT);
  const after = Date.now();

  assert.deepEqual(calls.slice(0, 3).map((c) => (Array.isArray(c) ? c[0] : c)), ["$transaction", "class.create", "lecture.create"], "the class, then its default lecture, inside one transaction");
  const lectures = defaultsOf(created.id);
  assert.equal(lectures.length, 1, "exactly one default lecture");
  const [lecture] = lectures;
  assert.equal(lecture.isDefault, true);
  assert.equal(lecture.classId, created.id);
  assert.equal(lecture.title, DEFAULT_LECTURE_TITLE);
  assert.equal(lecture.endDate, null, "no end (the end-date CHECK only applies to a non-null end)");
  assert.ok(lecture.date instanceof Date && lecture.date.getTime() >= before && lecture.date.getTime() <= after, "a real UTC instant: the creation time");
  assert.equal(Object.values(store.lectures).filter((l) => l.classId === created.id).length, 1, "no other lecture");
  assert.deepEqual(Object.keys(created).includes("lectures"), false, "the response shape is unchanged");
});

test("atomic: when the default lecture cannot be created, the class is rolled back too", async () => {
  reset();
  failLectureCreate = true;
  const classesBefore = Object.keys(store.classes).length;
  await assert.rejects(classService.createClassForTeacher(TEACHER, CLASS_INPUT), /simulated failure: Lecture\.create/);
  assert.equal(Object.keys(store.classes).length, classesBefore, "no class left behind");
  assert.equal(Object.values(store.lectures).filter((l) => l.classId.startsWith("new-class")).length, 0, "no lecture left behind");
});

test("POST /api/classes: the route still answers 201 with the class only (and creates its default lecture)", async () => {
  reset();
  process.env.APP_URL = "https://app.example.test";
  fake("lib/auth-session.ts", {
    requireTeacherSession: async () => ({ teacherId: TEACHER, role: "TEACHER" }),
    requireStudentSession: async () => { throw new Error("not used"); },
    requireAppSession: async () => { throw new Error("not used"); },
    requireAdminSession: async () => { throw new Error("not used"); },
    getOptionalSession: async () => null,
  });
  const route = require(path.join(root, "app", "api", "classes", "route.ts"));
  const response = await route.POST(
    new Request("https://app.example.test/api/classes", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.example.test" }, body: JSON.stringify(CLASS_INPUT) })
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(defaultsOf(body.data.class.id).length, 1);
});

test("editing an existing class never creates a default lecture", () => {
  const src = fs.readFileSync(path.join(root, "services", "class-service.ts"), "utf8");
  const update = src.slice(src.indexOf("export async function updateClassForTeacher"), src.indexOf("export async function getClassFeeHistoryForTeacher"));
  assert.ok(update.length > 100);
  assert.doesNotMatch(update, /lecture|defaultLectureData/i, "the class update touches no lecture");
  assert.equal((src.match(/defaultLectureData\(/g) ?? []).length, 1, "created in exactly one place: createClassForTeacher");
  const create = src.slice(src.indexOf("export async function createClassForTeacher"), src.indexOf("function createClassRow"));
  assert.match(create, /prisma\.\$transaction\(async \(tx\) => \{\s*const created = await createClassRow\(tx,[\s\S]*?await tx\.lecture\.create\(\{ data: defaultLectureData\(created\.id, now\)/);
});

test("defaultLectureData: flagged by isDefault (never title / date); endDate null", () => {
  const now = new Date("2026-11-24T10:00:00.000Z");
  assert.deepEqual({ ...defaultLectureData("c1", now) }, { classId: "c1", title: "General Notes", date: now, endDate: null, isDefault: true });
  assert.deepEqual({ ...NORMAL_LECTURE_WHERE }, { isDefault: false });
});

// ======================================================================================
// Normal lecture creation and the lecture service
// ======================================================================================

test("normal lecture creation cannot create a default lecture: isDefault is stripped and never set (column default false)", async () => {
  const body = { classId: CLASS, title: "Optics", date: "2026-11-20T09:00", isDefault: true };
  const parsed = createLectureSchema.parse(body);
  assert.equal("isDefault" in parsed, false, "create schema strips it");
  assert.equal("isDefault" in updateLectureSchema.parse({ title: "Renamed", isDefault: true }), false, "update schema strips it");

  reset();
  await lectureService.createLectureForTeacher(TEACHER, { ...parsed, isDefault: true });
  const [, data] = calls.find((c) => Array.isArray(c) && c[0] === "lecture.create");
  assert.equal("isDefault" in data, false, "the service never writes isDefault");
  assert.equal(Object.values(store.lectures).find((l) => l.title === "Optics").isDefault, false);

  reset();
  await prismaFake.$transaction((tx) => lectureService.createLectureForTeacher(TEACHER, { ...parsed, isDefault: true }, { db: tx }));
  assert.equal("isDefault" in calls.find((c) => Array.isArray(c) && c[0] === "lecture.create")[1], false, "nor on the attendance page's path");
});

test("lecture lists exclude the default lecture; normal lectures are listed as before", async () => {
  reset();
  const { lectures, totalItems } = await lectureService.listLecturesForTeacher({ teacherId: TEACHER, classId: CLASS, skip: 0, take: 50 });
  assert.deepEqual(lectures.map((l) => l.id), [NORMAL]);
  assert.equal(totalItems, 1);
  const byId = await lectureService.listLecturesForTeacher({ teacherId: TEACHER, lectureId: DEFAULT, skip: 0, take: 50 });
  assert.deepEqual(byId.lectures, [], "not even when asked for by id (the lecture detail page)");
});

test("normal single-lecture workflows refuse a default lecture (404) and write nothing; the note workflow keeps it", async () => {
  reset();
  const notFound = (error) => error.code === "LECTURE_NOT_FOUND" && error.statusCode === 404;
  await assert.rejects(lectureService.assertTeacherOwnsLecture(TEACHER, DEFAULT), notFound);
  await assert.rejects(lectureService.updateLectureForTeacher(TEACHER, DEFAULT, { title: "Renamed" }), notFound);
  await assert.rejects(lectureService.updateLectureClassStatusForTeacher(TEACHER, DEFAULT, "COMPLETED"), notFound);
  await assert.rejects(lectureService.updateLectureClassStatusForTeacher(TEACHER, DEFAULT, "CANCELLED"), notFound);
  await assert.rejects(lectureService.deleteLectureForTeacher(TEACHER, DEFAULT), notFound);
  assert.equal(calls.filter((c) => Array.isArray(c) && c[0] === "lecture.update").length, 0, "nothing written");
  assert.deepEqual(store.lectures[DEFAULT], { ...store.lectures[DEFAULT], title: "General Notes", status: 0, classStatus: "SCHEDULED", isDefault: true });

  const included = await lectureService.assertTeacherOwnsLecture(TEACHER, DEFAULT, { includeDefault: true });
  assert.equal(included.id, DEFAULT, "the note workflow (notes belong to the default lecture)");
  await assert.rejects(lectureService.assertTeacherOwnsLecture(OTHER, DEFAULT, { includeDefault: true }), notFound, "still the owner only");

  const normal = await lectureService.updateLectureForTeacher(TEACHER, NORMAL, { title: "Kinematics II" });
  assert.equal(normal.title, "Kinematics II", "normal lectures are unchanged");
});

test("which lecture-service functions keep the default lecture: the note workflow only", () => {
  const src = fs.readFileSync(path.join(root, "services", "lecture-service.ts"), "utf8");
  assert.equal((src.match(/\{ includeDefault: true \}/g) ?? []).length, 2, "listNotesForLectureForTeacher and addNoteToLectureForTeacher");
  const route = fs.readFileSync(path.join(root, "app", "api", "lectures", "[id]", "notes", "route.ts"), "utf8");
  assert.match(route, /assertTeacherOwnsLecture\(session\.teacherId, lectureId, \{ includeDefault: true \}\)/, "the note upload route");
});

// ======================================================================================
// Static guard: every Lecture list / count excludes the default lecture
// ======================================================================================

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}
function callText(src, index) {
  let depth = 0;
  for (let i = src.indexOf("(", index); i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")" && --depth === 0) return src.slice(index, i + 1);
  }
  return src.slice(index);
}
/** `where: name` passed through a variable: the variable's definition in the same file. */
function whereVariableFiltered(src, call) {
  const m =
    /where:\s*([A-Za-z_]\w*)\s*[,}]/.exec(call) ?? // where: name
    /where:\s*\{\s*\.\.\.([A-Za-z_]\w*)\s*,/.exec(call) ?? // where: { ...name, more }
    (/\bwhere,/.test(call) ? [null, "where"] : null); // where (shorthand)
  if (!m) return false;
  const def = new RegExp(`const ${m[1]}\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\}`).exec(src);
  return Boolean(def && def[0].includes("NORMAL_LECTURE_WHERE"));
}

/**
 * Single-row Lecture reads / writes without the filter, reviewed one by one:
 * none can reach a default lecture as a teaching session.
 */
const REVIEWED_UNFILTERED = {
  // The student's lecture notes: the note workflow (notes belong to the default lecture too).
  "app/api/student/lectures/[lectureId]/notes/route.ts": 1,
  // The class of whiteboards already listed (whiteboard creation refuses a default lecture).
  "app/api/student/lectures/[lectureId]/whiteboards/route.ts": 1,
  "services/lecture-whiteboard-service.ts": 1,
  // The Notes page's default lecture lookup itself (classId + isDefault: true, after the class /
  // enrolment check); its selected-lecture lookup uses NORMAL_LECTURE_WHERE.
  "services/class-notes-service.ts": 1,
  // Recorded Lectures only: an EXISTING upload's lecture re-check (assertLectureActiveForUpload, every
  // chunk / completion / recovery). A General Recording's upload is on the default lecture; it can only
  // be started through the class-scoped upload (startRecordingUpload with includeDefault, decided on
  // the server), and the start's own lecture query keeps NORMAL_LECTURE_WHERE otherwise.
  "services/recorded-lecture-upload-service.ts": 1,
  // Content -> class resolution for the access checks (any lecture, notes included).
  "services/class-access-service.ts": 1,
  // The fee-waiver state of a lecture the caller already checked (by id).
  "services/fee-waiver-events.ts": 1,
  // Writes after an ownership check that excludes it (assertTeacherOwnsLecture / the locked re-check).
  "services/lecture-service.ts": 2,
  // The LIVE write after assertTeacherOwnsLectureInClass (filtered) under the lecture lock.
  "services/session-service.ts": 1,
  // Session-end cleanups by id (nothing is started) and writes after a filtered lookup.
  "lib/youtube-feature-lifecycle.ts": 4,
  "lib/youtube-lecture.ts": 4,
};

test("static guard: every Lecture list / count query excludes the default lecture; unfiltered single-row calls are the reviewed ones", () => {
  const unfilteredLists = [];
  const unfilteredSingles = {};
  for (const file of ["app", "services", "lib"].flatMap(sourceFiles)) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of src.matchAll(/\b\w+\.lecture\.(findMany|count|groupBy|aggregate|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|update|updateMany)\(/g)) {
      const call = callText(src, m.index);
      if (call.includes("NORMAL_LECTURE_WHERE")) continue;
      const line = src.slice(0, m.index).split("\n").length;
      if (["findMany", "count", "groupBy", "aggregate"].includes(m[1])) {
        if (!whereVariableFiltered(src, call)) unfilteredLists.push(`${file}:${line}`);
      } else {
        unfilteredSingles[file] = (unfilteredSingles[file] ?? 0) + 1;
      }
    }
    for (const m of src.matchAll(/\blectures: \{\s*where:/g)) {
      if (!src.slice(m.index, m.index + 200).includes("NORMAL_LECTURE_WHERE")) unfilteredLists.push(`${file}:${src.slice(0, m.index).split("\n").length} (nested)`);
    }
  }
  assert.deepEqual(unfilteredLists, [], "lists and counts");
  assert.deepEqual(unfilteredSingles, REVIEWED_UNFILTERED, "a new unfiltered single-lecture call must be reviewed and listed here");
});

test("never identified by title or date: no code compares the default lecture's title", () => {
  const offenders = [];
  for (const file of ["app", "services", "lib", "components"].flatMap(sourceFiles)) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    if (/title:\s*(DEFAULT_LECTURE_TITLE|"General Notes")/.test(src) && file !== "lib/default-lecture.ts") offenders.push(file);
    if (/===\s*(DEFAULT_LECTURE_TITLE|"General Notes")/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
