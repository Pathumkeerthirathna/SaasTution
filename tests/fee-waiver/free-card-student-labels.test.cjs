/*
 * Class-level Free Card eligibility, Stage 4: the display-only
 * "Free Card Student" label in
 *   1. the student portal class list (app/student/classes/page.tsx),
 *   2. the guardian portal Classes tab (GuardianClassList in
 *      components/guardian/GuardianPortal.tsx),
 *   3. the teacher's Student Profile → Classes tab
 *      (app/student/Components/StudentClasses.tsx).
 * Real page / components / service (getStudentClassesForTeacher feeds both the
 * guardian and the teacher view), in-memory database from
 * ./helpers/fake-db.cjs, static rendering.
 *
 *   npm run test:fee-waiver
 *
 * Fixtures: student s1 is
 *   - Maths   (class-1): active enrolment, freeCardEligible true, no fee at all;
 *   - Physics (class-2): active enrolment, NOT eligible, but this month's fee
 *     carries a (manual) Free Card: must never show the label;
 *   - Chemistry (class-3): removed while eligible, re-enrolled (new enrolment
 *     not eligible): no label (the old enrolment's flag is not reused);
 *   - Biology (class-4): removed while eligible, not re-enrolled (a past class).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
// tsx compiles the components' JSX with the classic runtime here (React.createElement).
globalThis.React = React;

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("./helpers/fake-db.cjs");

const db = createFakeDb();

// Models the fee fake does not hold (live sessions, ...): empty.
const emptyDelegate = {
  count: async () => 0,
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
};
const client = new Proxy(db.client, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return emptyDelegate;
  },
});

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: client });
fake("lib/auth-session.ts", {
  requireStudentSession: async () => ({ role: "STUDENT", studentId: "s1" }),
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: "teacher-1" }),
  requireAppSession: async () => ({ role: "STUDENT", studentId: "s1" }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});
// The page's two realtime widgets need the Next.js app router: rendered as nothing here.
fake("components/student-portal/realtime-refresh.tsx", { RealtimeRefresh: () => null });
fake("components/student-portal/student-class-live-badge.tsx", { StudentClassLiveBadge: () => null });

const studentClassesPage = require(path.join(root, "app", "student", "classes", "page.tsx")).default;
const { GuardianClassList } = require(path.join(root, "components", "guardian", "GuardianPortal.tsx"));
const { StudentClasses } = require(path.join(root, "app", "student", "Components", "StudentClasses.tsx"));
const studentService = require(path.join(root, "services", "student-service.ts"));

const LABEL = "Free Card Student";
const T = "teacher-1";
const digits = (wall) => new Date(`${wall}:00.000Z`);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const count = (haystack, needle) => haystack.split(needle).length - 1;

const CLASSES = [
  ["class-1", "Maths", 2000],
  ["class-2", "Physics", 1500],
  ["class-3", "Chemistry", 1800],
  ["class-4", "Biology", 1700],
];

function seed() {
  db.reset();
  for (const [id, name, monthlyFee] of CLASSES) {
    db.insert("Class", {
      id,
      teacherId: T,
      status: 0,
      name,
      description: `${name} for grade 10`,
      monthlyFee,
      paymentDueWeek: 2,
      schedule: `${name} schedule`,
      teacher: { name: "Teacher One" },
      schedules: [],
      payments: [],
      studentHistory: [],
    });
  }
  db.insert("Student", { id: "s1", name: "Nimal", teacherId: T, status: 0 });

  const enrol = (id, classId, over = {}) =>
    db.insert("ClassStudent", { id, classId, studentId: "s1", isActive: true, assignedAt: digits("2026-12-01T10:00"), removedAt: null, removeReason: null, ...over });

  enrol("e-maths", "class-1", { freeCardEligible: true });
  enrol("e-physics", "class-2", { freeCardEligible: false });
  enrol("e-chem-old", "class-3", { isActive: false, freeCardEligible: true, assignedAt: digits("2026-10-01T10:00"), removedAt: digits("2026-11-01T10:00") });
  enrol("e-chem-new", "class-3", { freeCardEligible: false, assignedAt: digits("2026-11-15T10:00") });
  enrol("e-bio-old", "class-4", { isActive: false, freeCardEligible: true, assignedAt: digits("2026-09-01T10:00"), removedAt: digits("2026-10-01T10:00") });

  // Physics: this month's fee settled by a (manual) Free Card. Fee-level data
  // that must NOT turn into the class-level label.
  db.insert("ClassStudentFee", {
    id: "fee-physics-dec",
    classStudentId: "e-physics",
    year: 2026,
    month: 12,
    amount: 1500,
    finalAmount: 0,
    freeCard: true,
    freeCardIssuedAt: digits("2026-12-02T10:00"),
    freeCardIssuedByTeacherId: T,
  });
}

/**
 * Splits rendered HTML into one segment per class: from its name to the next
 * class name (cards appear in some order; each segment holds its own card).
 */
function segments(html) {
  const marks = CLASSES.map(([, name]) => [name, html.indexOf(`>${name}<`)])
    .filter(([, at]) => at >= 0)
    .sort((a, b) => a[1] - b[1]);
  const out = {};
  marks.forEach(([name, at], i) => {
    out[name] = html.slice(at, i + 1 < marks.length ? marks[i + 1][1] : html.length);
  });
  return out;
}

/** The teacher / guardian API data: the real service, through JSON like the routes. */
async function apiRows() {
  return JSON.parse(JSON.stringify(await studentService.getStudentClassesForTeacher("s1")));
}

// ---- data source ------------------------------------------------------------------------------

test("the enrolment's own freeCardEligible is in the shared classes data (teacher profile + guardian API)", async () => {
  seed();
  const rows = await apiRows();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.freeCardEligible]));
  assert.deepEqual(byId, {
    "e-maths": true,
    "e-physics": false,
    "e-chem-old": true,
    "e-chem-new": false,
    "e-bio-old": true,
  });
  // The fee-level card is still reported, separately (unchanged).
  assert.deepEqual(rows.find((r) => r.id === "e-physics").fees.map((f) => f.id), ["fee-physics-dec"]);
});

// ---- 1, 2: student portal class list --------------------------------------------------------

test("student portal: the label for an eligible class, not for a normal one", async () => {
  seed();
  const html = renderToStaticMarkup(await studentClassesPage());
  const cards = segments(html);

  assert.equal(count(text(cards.Maths), LABEL), 1, "Maths: eligible");
  assert.equal(count(text(cards.Physics), LABEL), 0, "Physics: not eligible (a fee Free Card is not the label)");
  assert.equal(count(text(cards.Chemistry), LABEL), 0, "Chemistry: re-enrolled, the new enrolment is not eligible");
  assert.equal(count(text(html), LABEL), 1, "exactly one label on the page");
});

test("student portal: a past (removed) class never shows the label, even if that enrolment was eligible", async () => {
  seed();
  const cards = segments(renderToStaticMarkup(await studentClassesPage()));
  assert.ok(cards.Biology, "the past class is still listed");
  assert.match(text(cards.Biology), /Past/);
  assert.equal(count(text(cards.Biology), LABEL), 0);
});

test("student portal: class information and navigation are unchanged", async () => {
  seed();
  const html = renderToStaticMarkup(await studentClassesPage());
  const cards = segments(html);

  for (const [id, name, fee] of CLASSES.slice(0, 2)) {
    const card = cards[name];
    assert.match(text(card), /Enrolled/);
    assert.match(text(card), new RegExp(`Rs ${fee.toLocaleString()}`));
    assert.match(text(card), /Week 2/);
    assert.match(text(card), new RegExp(`${name} schedule`));
    for (const href of [
      `/student/lectures?classId=${id}&amp;scheduled=1`,
      `/student/recorded-lectures?classId=${id}`,
      `/student/assignments?classId=${id}`,
      `/student/quizzes?classId=${id}`,
      `/student/payments?classId=${id}`,
    ]) {
      assert.ok(card.includes(`href="${href}"`), `${name}: ${href}`);
    }
  }
});

// ---- 3, 4: guardian portal Classes tab ------------------------------------------------------

test("guardian Classes tab: the label for an eligible class, not for a normal one", async () => {
  seed();
  const html = renderToStaticMarkup(React.createElement(GuardianClassList, { rows: await apiRows() }));
  const cards = segments(html);

  assert.equal(count(text(cards.Maths), LABEL), 1);
  assert.equal(count(text(cards.Physics), LABEL), 0, "a fee Free Card is not the label");
  assert.equal(count(text(cards.Chemistry), LABEL), 0, "the old enrolment's eligibility is not reused");
  assert.equal(cards.Biology, undefined, "past classes are not listed (unchanged)");
  assert.equal(count(text(html), LABEL), 1);
});

test("guardian Classes tab: class information unchanged", async () => {
  seed();
  const cards = segments(renderToStaticMarkup(React.createElement(GuardianClassList, { rows: await apiRows() })));
  assert.match(text(cards.Maths), /Maths schedule Maths for grade 10 Rs\. 2,000 \/ month/);
  assert.match(text(cards.Physics), /Physics schedule Physics for grade 10 Rs\. 1,500 \/ month/);
  assert.equal(
    text(renderToStaticMarkup(React.createElement(GuardianClassList, { rows: [] }))),
    "Not enrolled in any classes."
  );
});

// ---- 5, 6: teacher Student Profile → Classes tab -------------------------------------------

test("teacher Student Profile → Classes: the label for an eligible class, not for a normal one", async () => {
  seed();
  const html = renderToStaticMarkup(React.createElement(StudentClasses, { studentId: "s1", data: await apiRows() }));
  const cards = segments(html);

  assert.equal(count(text(cards.Maths), LABEL), 1);
  assert.equal(count(text(cards.Physics), LABEL), 0, "a fee Free Card is not the label");
  assert.equal(count(text(cards.Chemistry), LABEL), 0, "re-enrolled: the active enrolment decides");
  assert.equal(count(text(cards.Biology), LABEL), 0, "removed: no label");
  assert.equal(count(text(html), LABEL), 1);
});

test("teacher Student Profile → Classes: class information and the Free Card month list unchanged", async () => {
  seed();
  const cards = segments(renderToStaticMarkup(React.createElement(StudentClasses, { studentId: "s1", data: await apiRows() })));
  assert.match(text(cards.Maths), /Active/);
  assert.match(text(cards.Biology), /Removed/);
  assert.match(text(cards.Chemistry), /2 enrolments/);
  assert.match(text(cards.Physics), /free card/i, "the fee-level Free Card month is still shown as before");
});

// ---- 7, 8: source and independence -----------------------------------------------------------

test("eligibility comes only from the enrolment: flipping it moves the label; fee Free Cards never do", async () => {
  seed();
  // Make Physics eligible and Maths not; give Maths a fee Free Card.
  db.touch("ClassStudent", "e-physics", { freeCardEligible: true });
  db.touch("ClassStudent", "e-maths", { freeCardEligible: false });
  db.insert("ClassStudentFee", {
    id: "fee-maths-dec",
    classStudentId: "e-maths",
    year: 2026,
    month: 12,
    amount: 2000,
    finalAmount: 0,
    freeCard: true,
    freeCardIssuedAt: digits("2026-12-02T10:00"),
    freeCardIssuedByTeacherId: T,
  });

  const rows = await apiRows();
  for (const html of [
    renderToStaticMarkup(await studentClassesPage()),
    renderToStaticMarkup(React.createElement(GuardianClassList, { rows })),
    renderToStaticMarkup(React.createElement(StudentClasses, { studentId: "s1", data: rows })),
  ]) {
    const cards = segments(html);
    assert.equal(count(text(cards.Physics), LABEL), 1, "Physics: now eligible");
    assert.equal(count(text(cards.Maths), LABEL), 0, "Maths: a fee Free Card alone shows no label");
  }
});

test("class-specific: eligible in Maths only, the other classes of the same student stay unlabelled", async () => {
  seed();
  const rows = await apiRows();
  const labelled = (html) => {
    const cards = segments(html);
    return Object.keys(cards).filter((name) => count(text(cards[name]), LABEL) > 0);
  };
  assert.deepEqual(labelled(renderToStaticMarkup(await studentClassesPage())), ["Maths"]);
  assert.deepEqual(labelled(renderToStaticMarkup(React.createElement(GuardianClassList, { rows }))), ["Maths"]);
  assert.deepEqual(labelled(renderToStaticMarkup(React.createElement(StudentClasses, { studentId: "s1", data: rows }))), ["Maths"]);
});
