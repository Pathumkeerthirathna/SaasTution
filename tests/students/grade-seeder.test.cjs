/*
 * prisma/GradeSeeder.ts: safe to run again on any database. Grade 0 always
 * gets the fixed id 0; Grade 1..13 are matched by name; nothing is ever
 * duplicated, changed or deleted.
 *
 *   node --test tests/students/grade-seeder.test.cjs
 *
 * The seeder runs for real through tsx against an in-memory Grade table (its
 * `new PrismaClient()` is replaced; no database is contacted). The id
 * sequence behaves like PostgreSQL's: an explicit id (Grade 0) never moves it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const SEEDER = path.join(root, "prisma", "GradeSeeder.ts");

let table = [];
let sequence = 0;
let done;

const insensitive = (where, row) =>
  !where.GradeDesc || row.GradeDesc.toLowerCase() === where.GradeDesc.equals.toLowerCase();

class FakePrismaClient {
  constructor() {
    this.grade = {
      findUnique: async ({ where }) => table.find((r) => r.id === where.id) ?? null,
      findFirst: async ({ where }) => table.find((r) => insensitive(where, r)) ?? null,
      create: async ({ data }) => {
        if (data.id !== undefined && table.some((r) => r.id === data.id)) throw new Error("P2002 id");
        const row = { id: data.id ?? ++sequence, GradeDesc: data.GradeDesc, Status: data.Status ?? 0 };
        table.push(row);
        return row;
      },
      createMany: async () => {
        throw new Error("the seeder must not use createMany (skipDuplicates cannot see a duplicate name)");
      },
    };
  }
  async $disconnect() {
    done();
  }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === "@prisma/client" && parent && parent.filename === SEEDER) return { PrismaClient: FakePrismaClient };
  return originalLoad.call(this, request, parent, ...rest);
};

const warnings = [];
async function runSeeder() {
  delete require.cache[SEEDER];
  const finished = new Promise((resolve) => (done = resolve));
  const { warn, error } = console;
  console.warn = (message) => warnings.push(message);
  console.error = (e) => {
    throw e;
  };
  try {
    require(SEEDER);
    await finished;
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const snapshot = () => JSON.parse(JSON.stringify([...table].sort((a, b) => a.id - b.id)));
const NUMBERED = Array.from({ length: 13 }, (_, i) => ({ id: i + 1, GradeDesc: `Grade ${i + 1}`, Status: 1 }));

function start(rows, nextSequence) {
  table = JSON.parse(JSON.stringify(rows));
  sequence = nextSequence;
  warnings.length = 0;
}

test("empty table: Grade 0 (id 0) and Grade 1..13 (ids 1..13); a second run adds nothing", async () => {
  start([], 0);
  await runSeeder();
  assert.deepEqual(snapshot(), [{ id: 0, GradeDesc: "Grade 0", Status: 1 }, ...NUMBERED]);
  const first = snapshot();
  await runSeeder();
  await runSeeder();
  assert.deepEqual(snapshot(), first, "re-runs change nothing");
  assert.deepEqual(warnings, []);
});

test("existing database (Grade 1..13, one soft-deleted): only Grade 0 is added; existing rows untouched", async () => {
  const existing = NUMBERED.map((g) => (g.id === 1 ? { ...g, Status: 0 } : g));
  start(existing, 13);
  await runSeeder();
  assert.deepEqual(snapshot(), [{ id: 0, GradeDesc: "Grade 0", Status: 1 }, ...existing]);
  assert.equal(sequence, 13, "the explicit id 0 never moved the id sequence");
  await runSeeder();
  assert.equal(table.length, 14);
});

test("\"Grade 0\" already under another id: nothing is inserted (no duplicate), reported", async () => {
  start([...NUMBERED, { id: 20, GradeDesc: "grade 0", Status: 1 }], 20);
  const before = snapshot();
  await runSeeder();
  assert.deepEqual(snapshot(), before);
  assert.match(warnings.join("\n"), /"Grade 0" exists with id 20/);
});

test("id 0 holding another grade: left unchanged, reported", async () => {
  start([{ id: 0, GradeDesc: "Other", Status: 1 }, ...NUMBERED], 13);
  const before = snapshot();
  await runSeeder();
  assert.deepEqual(snapshot(), before);
  assert.match(warnings.join("\n"), /Grade id 0 exists as "Other"/);
});

test("a missing numbered grade is filled in from the sequence; the others are not duplicated", async () => {
  start(NUMBERED.filter((g) => g.id !== 13), 12);
  await runSeeder();
  assert.equal(table.filter((g) => g.GradeDesc === "Grade 13").length, 1);
  assert.equal(table.find((g) => g.GradeDesc === "Grade 13").id, 13);
  assert.equal(table.length, 14);
});
