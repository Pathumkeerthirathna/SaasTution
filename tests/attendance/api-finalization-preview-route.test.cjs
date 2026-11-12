/*
 * GET /api/lectures/[id]/attendance/finalization (Stage 5.5c), in-process with
 * the real routes, preview and finalization services, error handler and
 * same-origin check; faked edges: session and Prisma
 * (helpers/attendance-route-env.cjs). No database; not a real-PostgreSQL
 * concurrency validation.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset, student, visit, register, seedRecord, at, NOW, T1, T2, L1, ctx, get, assertNoStore, BAD_IDS, withEnv, root } = env;

const previewRoute = require(path.join(root, "app", "api", "lectures", "[id]", "attendance", "finalization", "route.ts"));
const previewService = require(path.join(root, "services", "lecture-attendance-finalization-preview-service.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const PREVIEW = (id = L1) => previewRoute.GET(get(`/api/lectures/${id}/attendance/finalization`), ctx(id));
const json = async (response) => ({ status: response.status, body: await response.json() });

function mixedClass() {
  register();
  student("s-present");
  seedRecord("s-present", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  visit("s-present", at(2));
  student("s-no-show-1");
  student("s-no-show-2");
  student("s-unknown", { broken: true });
}

// ---- Preview GET ----------------------------------------------------------------------------------

test("preview: the service's response unchanged (fingerprint included), no student identities, no-store", async () => {
  reset();
  mixedClass();
  const response = await PREVIEW();
  assert.equal(response.status, 200);
  assertNoStore(assert, response);
  const text = await response.text();
  const { data } = JSON.parse(text);
  const direct = await previewService.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 });
  assert.deepEqual(data, JSON.parse(JSON.stringify(direct)), "the same contract, serialized");
  assert.match(data.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(data.fingerprint, direct.fingerprint);
  assert.deepEqual([data.summary.automaticAbsent, data.summary.manualReview, data.readiness.ready], [2, 1, true]);
  for (const secret of ["s-no-show", "s-present", "Name of", "REG-", "rec-", "sess-a", "visit-"]) assert.ok(!text.includes(secret), secret);
});

test("preview: live and historical lectures; blockers reported", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  state.pg.committed.sessions["sess-a"].isActive = true;
  const live = (await json(await PREVIEW())).body.data;
  assert.equal(live.classification, "LIVE");
  assert.deepEqual(live.readiness.blockers, ["SESSION_ACTIVE", "EVIDENCE_PENDING"]);
  assert.equal(live.readiness.ready, false);

  reset({ date: new Date("2026-08-10T12:30:00Z"), endDate: new Date("2026-08-10T14:30:00Z") });
  student("s1");
  const historical = (await json(await PREVIEW())).body.data;
  assert.deepEqual([historical.classification, historical.readiness.ready, historical.summary.automaticAbsent], ["HISTORICAL", true, 1]);
});

test("preview: 503 for missing / invalid configuration (setting and status only); 401 / 404 / 400", async () => {
  reset();
  student("s1");
  await withEnv({ APPROVAL_FEATURE_STARTED_AT: "not-an-instant" }, async () => {
    const { status, body } = await json(await PREVIEW());
    assert.equal(status, 503);
    assert.deepEqual(body.error.details, { setting: "APPROVAL_FEATURE_STARTED_AT", status: "INVALID" });
    assert.ok(!JSON.stringify(body).includes("not-an-instant"));
  });
  state.session = null;
  assert.equal((await PREVIEW()).status, 401);
  state.session = { role: "STUDENT", userId: "s1" };
  assert.equal((await PREVIEW()).status, 401);
  state.session = { role: "TEACHER", userId: T2 };
  assert.equal((await PREVIEW()).status, 404);
  state.session = { role: "TEACHER", userId: T1 };
  for (const id of BAD_IDS) assert.equal((await PREVIEW(id)).status, 400);
  state.pg.committed.lectures[L1].status = 1;
  assert.equal((await PREVIEW()).status, 404);
  assert.equal(state.pg.transactions.length, 0, "read only");
});

