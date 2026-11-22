/*
 * Batch Start Date (Class.startDate) with the 1900-01-01 "not given" sentinel:
 * lib/class-start-date.ts, the class form payload, validation, the class
 * routes (POST /api/classes, PUT /api/classes/[id]) and service, and the
 * student-facing class card. No schema change, no migration.
 *
 *   node --test tests/classes/batch-start-date.test.cjs
 *
 * Faked edges: Prisma (recording, classes only), the session, realtime events,
 * and next/navigation's router (to render the card outside Next.js).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
globalThis.React = React;

const root = path.resolve(__dirname, "..", "..");
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

const APP_ORIGIN = "https://app.example.test";
process.env.APP_URL = APP_ORIGIN;
const T1 = "teacher-1";
const C1 = "class-1";
const SENTINEL = "1900-01-01";

// ---- Fakes --------------------------------------------------------------------------------------

const state = { classes: {}, calls: [] };
const prismaFake = {
  class: {
    create: async ({ data }) => {
      state.calls.push(["class.create", data]);
      const id = `class-${Object.keys(state.classes).length + 1}`;
      state.classes[id] = { id, ...data, status: 0 };
      return { id, name: data.name };
    },
    findFirst: async ({ where }) => {
      const c = state.classes[where.id];
      return c && c.teacherId === where.teacherId && c.status === where.status ? { id: c.id, monthlyFee: c.monthlyFee } : null;
    },
  },
  $transaction: async (fn) =>
    fn({
      classSchedule: { deleteMany: async () => ({ count: 0 }) },
      classFee: { count: async () => 1, updateMany: async () => ({ count: 1 }), create: async () => ({}) },
      class: {
        update: async ({ where, data }) => {
          state.calls.push(["class.update", data]);
          Object.assign(state.classes[where.id], data);
          return { ...state.classes[where.id] };
        },
      },
    }),
};
fake("lib/prisma.ts", { prisma: prismaFake });
fake("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ teacherId: T1, role: "TEACHER" }),
  requireStudentSession: async () => { throw new AppError("Authentication required.", 401, "UNAUTHORIZED"); },
  requireAppSession: async () => ({ userId: T1, role: "TEACHER" }),
  requireAdminSession: async () => { throw new AppError("Admin privileges are required.", 403, "FORBIDDEN"); },
  getOptionalSession: async () => null,
});
// The class card uses next/navigation's router; outside Next.js it is a no-op stand-in.
fakeAt(require.resolve("next/navigation", { paths: [path.join(root, "components")] }), { useRouter: () => ({ push: () => {} }) });

const DATES = require(path.join(root, "lib", "class-start-date.ts"));
const { buildClassFormPayload } = require(path.join(root, "components", "class-form-payload.ts"));
const { createClassSchema, updateClassSchema } = require(path.join(root, "lib", "class-validation.ts"));
const createRoute = require(path.join(root, "app", "api", "classes", "route.ts"));
const updateRoute = require(path.join(root, "app", "api", "classes", "[id]", "route.ts"));
const Card = require(path.join(root, "components", "teacherProfile", "TeacherClassesCard.tsx")).default;

function reset() {
  state.calls = [];
  state.classes = { [C1]: { id: C1, teacherId: T1, status: 0, name: "Physics", monthlyFee: 1000, startDate: new Date(`${SENTINEL}T00:00:00.000Z`) } };
}
test.beforeEach(reset);

const BASE = { name: "Physics", monthlyFee: 1500, paymentDueWeek: 1, schedules: [{ dayOfWeek: "MONDAY", startTime: "08:00", endTime: "10:00" }] };
const FORM = { name: "Physics", description: "", monthlyFee: "1500", paymentDueWeek: "1", attendanceGraceMinutes: "10", startDate: "", schedules: BASE.schedules };

function request(url, method, body) {
  return new Request(`${APP_ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
const stored = (id) => state.classes[id].startDate;
const iso = (date) => date.toISOString();

// ==== 1. The sentinel helpers ===========================================================================

test("helpers: an empty input becomes 1900-01-01; a chosen date is sent unchanged", () => {
  assert.equal(DATES.CLASS_START_DATE_NOT_SET, SENTINEL);
  for (const empty of ["", "   ", null, undefined]) assert.equal(DATES.classStartDateForCreate(empty), SENTINEL, String(empty));
  assert.equal(DATES.classStartDateForCreate("2026-12-01"), "2026-12-01");
  assert.equal(DATES.classStartDateForCreate(SENTINEL), SENTINEL);
});

test("helpers: only real calendar dates YYYY-MM-DD", () => {
  for (const ok of [SENTINEL, "2026-12-01", "2028-02-29"]) assert.equal(DATES.isCalendarDateString(ok), true, ok);
  for (const bad of ["", "2026-02-30", "2026-13-01", "2027-02-29", "01/12/2026", "2026-1-5", "2026-12-01T00:00:00Z", "abc", null, 20261201]) {
    assert.equal(DATES.isCalendarDateString(bad), false, String(bad));
  }
});

test("helpers: the saved value as the date input's YYYY-MM-DD (by its UTC date), the sentinel included; '' only when none", () => {
  assert.equal(DATES.classStartDateInputValue("1900-01-01T00:00:00.000Z"), SENTINEL);
  assert.equal(DATES.classStartDateInputValue(new Date("1900-01-01T00:00:00.000Z")), SENTINEL);
  assert.equal(DATES.classStartDateInputValue("2026-12-01T00:00:00.000Z"), "2026-12-01");
  assert.equal(DATES.classStartDateInputValue(SENTINEL), SENTINEL);
  for (const none of [null, undefined, "", "not a date"]) assert.equal(DATES.classStartDateInputValue(none), "", String(none));
});

test("helpers: hasClassStartDate is false for the sentinel and for none; true for a real date", () => {
  for (const notShown of [SENTINEL, "1900-01-01T00:00:00.000Z", new Date("1900-01-01T00:00:00.000Z"), null, undefined, "", "garbage"]) {
    assert.equal(DATES.hasClassStartDate(notShown), false, String(notShown));
  }
  for (const shown of ["2026-12-01", "2026-12-01T00:00:00.000Z", new Date("2020-05-10T00:00:00.000Z")]) assert.equal(DATES.hasClassStartDate(shown), true, String(shown));
});

test("time zones: 1900-01-01 is stored as UTC midnight and read back as 1900-01-01 in Colombo, Los Angeles and Kiritimati alike", () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ["Asia/Colombo", "America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      process.env.TZ = tz;
      for (const day of [SENTINEL, "2026-12-01", "2026-03-29"]) {
        const date = DATES.classStartDateToDate(day);
        assert.equal(date.toISOString(), `${day}T00:00:00.000Z`, `${tz} ${day}`);
        assert.equal(DATES.classStartDateInputValue(date.toISOString()), day, `${tz} round trip ${day}`);
        assert.equal(date.getTime(), new Date(day).getTime(), `${tz}: the same instant as the previous new Date(day)`);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

// ==== 2. The class forms' payloads ======================================================================

test("create form: an empty Batch Start Date is sent as 1900-01-01; a selected date unchanged", () => {
  assert.equal(buildClassFormPayload({ ...FORM, startDate: "" }, "create").body.startDate, SENTINEL);
  assert.equal(buildClassFormPayload({ ...FORM, startDate: "" }).body.startDate, SENTINEL, "create is the default mode");
  assert.equal(buildClassFormPayload({ ...FORM, startDate: "2026-12-01" }, "create").body.startDate, "2026-12-01");
});

test("edit form: the shown value is sent (the sentinel too, or the teacher's replacement); an empty input sends nothing (unchanged)", () => {
  assert.equal(buildClassFormPayload({ ...FORM, startDate: SENTINEL }, "update").body.startDate, SENTINEL);
  assert.equal(buildClassFormPayload({ ...FORM, startDate: "2027-01-10" }, "update").body.startDate, "2027-01-10");
  assert.equal("startDate" in buildClassFormPayload({ ...FORM, startDate: "" }, "update").body, false);
  const body = buildClassFormPayload({ ...FORM, startDate: "2026-12-01" }, "update").body;
  assert.deepEqual(Object.keys(body).sort(), ["attendanceGraceMinutes", "description", "monthlyFee", "name", "paymentDueWeek", "schedules", "startDate"], "the other fields as before");
});

// ==== 3. Validation =====================================================================================

test("validation: the sentinel and real dates are accepted unchanged; malformed / impossible dates are refused; omitted is allowed", () => {
  for (const day of [SENTINEL, "2026-12-01"]) {
    assert.equal(createClassSchema.parse({ ...BASE, startDate: day }).startDate, day);
    assert.equal(updateClassSchema.parse({ startDate: day }).startDate, day, "a date alone is a valid update");
  }
  assert.equal(createClassSchema.parse(BASE).startDate, undefined);
  for (const bad of ["", "2026-02-30", "abc", "01/12/2026", 20261201, null]) {
    assert.equal(createClassSchema.safeParse({ ...BASE, startDate: bad }).success, false, `create ${String(bad)}`);
    assert.equal(updateClassSchema.safeParse({ startDate: bad }).success, false, `update ${String(bad)}`);
  }
  assert.equal(updateClassSchema.safeParse({}).success, false, "an empty update is still refused");
});

// ==== 4. Routes and service: stored as sent, never replaced ===============================================

test("create: an empty Batch Start Date (sent as the sentinel) is stored as 1900-01-01 - not today", async () => {
  const body = buildClassFormPayload({ ...FORM, startDate: "" }, "create").body;
  const res = await createRoute.POST(request("/api/classes", "POST", body));
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(iso(stored(data.class.id)), "1900-01-01T00:00:00.000Z");
});

test("create: a selected date is stored as that day; the sentinel sent explicitly is kept", async () => {
  for (const day of ["2026-12-01", SENTINEL]) {
    const res = await createRoute.POST(request("/api/classes", "POST", { ...BASE, startDate: day }));
    assert.equal(res.status, 201, day);
    const { data } = await res.json();
    assert.equal(iso(stored(data.class.id)), `${day}T00:00:00.000Z`, day);
  }
});

test("create: no Batch Start Date at all is stored as the sentinel (never the current date); an invalid one is refused with 400 (nothing created)", async () => {
  const before = Date.now();
  const res = await createRoute.POST(request("/api/classes", "POST", BASE));
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(iso(stored(data.class.id)), "1900-01-01T00:00:00.000Z");
  assert.ok(stored(data.class.id).getTime() < before, "not now");
  const created = Object.keys(state.classes).length;
  for (const bad of ["", "2026-02-30", "garbage"]) {
    const refused = await createRoute.POST(request("/api/classes", "POST", { ...BASE, startDate: bad }));
    assert.equal(refused.status, 400, bad);
    assert.equal((await refused.json()).error.code, "VALIDATION_ERROR");
  }
  assert.equal(Object.keys(state.classes).length, created);
});

test("edit: the teacher replaces 1900-01-01 with a real date and saves normally", async () => {
  const body = buildClassFormPayload({ ...FORM, startDate: "2027-01-10" }, "update").body;
  const res = await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", body), { params: { id: C1 } });
  assert.equal(res.status, 200);
  assert.equal(iso(stored(C1)), "2027-01-10T00:00:00.000Z");
});

test("edit: saving with the sentinel shown keeps 1900-01-01; an edit that leaves the date empty does not touch it", async () => {
  let res = await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", buildClassFormPayload({ ...FORM, name: "Physics A", startDate: SENTINEL }, "update").body), { params: { id: C1 } });
  assert.equal(res.status, 200);
  assert.equal(iso(stored(C1)), "1900-01-01T00:00:00.000Z");
  state.classes[C1].startDate = null; // a legacy class without a date
  state.calls = [];
  res = await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", buildClassFormPayload({ ...FORM, name: "Physics B", startDate: "" }, "update").body), { params: { id: C1 } });
  assert.equal(res.status, 200);
  const update = state.calls.find(([kind]) => kind === "class.update")[1];
  assert.equal("startDate" in update, false, "no startDate written");
  assert.equal(state.classes[C1].startDate, null, "the existing record is unchanged");
  assert.equal(state.classes[C1].name, "Physics B", "the rest of the edit saved normally");
});

// ==== 5. What students see ================================================================================

const cls = (startDate) => ({ id: "c-1", name: "A/L Physics", description: null, teacherId: T1, monthlyFee: 2500, paymentDueWeek: 1, startDate, schedule: "Mon", schedules: [] });
const render = (startDate) => renderToStaticMarkup(React.createElement(Card, { classes: [cls(startDate)], isPublic: true }));

const VISUALS = require(path.join(root, "components", "class-card-visuals.tsx"));
const AMBER = ["rounded-lg", "border", "border-amber-300", "bg-amber-400", "px-3.5", "py-2", "text-sm", "font-bold", "text-slate-900", "shadow-md", "shadow-black/20"];
const futureDay = () => {
  const d = new Date(Date.now() + 30 * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

test("upcoming badge: only a real FUTURE Batch Start Date; never the sentinel, a past date, none or an unreadable one", () => {
  const now = Date.UTC(2026, 10, 22);
  assert.equal(VISUALS.isUpcomingClassStart("2027-06-25T00:00:00.000Z", now), true);
  for (const no of ["1900-01-01T00:00:00.000Z", "1900-01-01", new Date("1900-01-01T00:00:00.000Z"), "2020-05-10T00:00:00.000Z", null, undefined, "", "garbage"]) {
    assert.equal(VISUALS.isUpcomingClassStart(no, now), false, String(no));
  }
  assert.equal(VISUALS.formatClassStartDate("2027-06-25T00:00:00.000Z"), "25 Jun 2027");
  const saved = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles"; // UTC midnight is the previous evening there: still the stored day
    assert.equal(VISUALS.formatClassStartDate("2027-06-25T00:00:00.000Z"), "25 Jun 2027");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("upcoming badge: the dashboard's amber design - calendar icon, 'Upcoming Class', the date after a divider", () => {
  const html = renderToStaticMarkup(React.createElement(VISUALS.UpcomingClassBadge, { startDate: "2099-06-25T00:00:00.000Z" }));
  const cls = /data-upcoming-class-badge="" class="([^"]+)"/.exec(html)[1].split(/\s+/);
  for (const c of [...AMBER, "inline-flex", "items-center", "gap-2"]) assert.ok(cls.includes(c), c);
  assert.match(html, /<svg[^>]*lucide-calendar-days/);
  assert.match(html, /<span>Upcoming Class<\/span><span class="border-l border-amber-700\/30 pl-2">25 Jun 2099<\/span>/);
  assert.equal(renderToStaticMarkup(React.createElement(VISUALS.UpcomingClassBadge, { startDate: "1900-01-01T00:00:00.000Z" })), "");
});

test("public profile class card: the amber 'Upcoming Class' badge for a real future date; nothing for 1900-01-01, a past date or none (as before)", () => {
  const sentinel = render("1900-01-01T00:00:00.000Z");
  assert.doesNotMatch(sentinel, /Upcoming|1900|01 Jan 1900/);
  const iso = futureDay();
  const shown = render(iso);
  assert.match(shown, /data-upcoming-class-badge=""[^>]*bg-amber-400/);
  assert.match(shown, /Upcoming Class/);
  assert.ok(shown.includes(VISUALS.formatClassStartDate(iso)));
  assert.doesNotMatch(shown, /Upcoming: /, "the old translucent chip is gone");
  assert.doesNotMatch(render("2020-05-10T00:00:00.000Z"), /Upcoming/, "a past real date: as before");
  assert.doesNotMatch(render(null), /Upcoming/, "no date: as before");
  // In the header's bottom row, opposite the schedule (wraps on narrow screens; never over the title).
  assert.match(shown, /flex flex-wrap items-center justify-between gap-2 border-t border-white\/10 pt-2">\s*<span[^>]*>Mon<\/span><div data-upcoming-class-badge/);
});

test("both class cards use the ONE shared badge (no duplicated markup or date logic)", () => {
  const panel = fs.readFileSync(path.join(root, "components", "class-management-panel.tsx"), "utf8");
  const card = fs.readFileSync(path.join(root, "components", "teacherProfile", "TeacherClassesCard.tsx"), "utf8");
  for (const [name, src] of [["dashboard", panel], ["public profile", card]]) {
    assert.match(src, /<UpcomingClassBadge startDate=\{item\.startDate\} \/>/, name);
    assert.doesNotMatch(src, /bg-amber-400/, `${name}: no copy of the badge styling`);
    assert.doesNotMatch(src, /Upcoming Class|Upcoming: /, `${name}: no copy of the badge text`);
  }
});

test("teacher edit form: a Batch Start Date input bound to the saved value (1900-01-01 shown as is), explained when it is the sentinel", () => {
  const panel = fs.readFileSync(path.join(root, "components", "class-management-panel.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(panel, /startDate: classStartDateInputValue\(item\.startDate\),/, "beginEdit loads the saved date as YYYY-MM-DD");
  assert.match(panel, /id="editBatchStartDate"\s+type="date"\s+value=\{editForm\.startDate\}/);
  assert.match(panel, /editForm\.startDate === CLASS_START_DATE_NOT_SET\s*\?\s*"No batch start date was given \(1900-01-01\)/);
  assert.match(panel, /const updatePayload = buildClassFormPayload\(editForm, "update"\);/);
  assert.match(panel, /const createPayload = buildClassFormPayload\(createForm\);/, "create: the default (empty -> sentinel)");
});
