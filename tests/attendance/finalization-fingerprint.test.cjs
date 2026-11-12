/*
 * Stage 5.5a: the pure finalization fingerprint (lib/attendance/finalization-fingerprint.ts).
 *
 *   npm run test:attendance-finalization-preview
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const fpLib = require(path.join(root, "lib", "attendance", "finalization-fingerprint.ts"));

const d = (iso) => new Date(iso);

function base() {
  return {
    lecture: { id: "L1", status: 0, classStatus: "COMPLETED", date: d("2026-09-01T12:30:00Z"), endDate: d("2026-09-01T14:30:00Z") },
    register: { exists: true, version: 3, scheduledStartAt: d("2026-09-01T12:30:00Z"), scheduledEndAt: d("2026-09-01T14:30:00Z"), graceMinutes: 10, finalizedAt: null },
    records: [
      { studentId: "s2", id: "r2", version: 1, status: "LATE", statusSource: "AUTO" },
      { studentId: "s1", id: "r1", version: 2, status: "PRESENT", statusSource: "TEACHER" },
    ],
    candidates: [
      { studentId: "s3", decision: "CREATE_ABSENT", eligibilityOutcome: "ELIGIBLE", eligibilityReason: "ELIGIBLE", approvalReason: "KNOWN_APPROVED" },
      { studentId: "s1", decision: "HAS_RECORD", eligibilityOutcome: "ELIGIBLE", eligibilityReason: "ELIGIBLE", approvalReason: "KNOWN_APPROVED" },
      { studentId: "s2", decision: "HAS_RECORD", eligibilityOutcome: "ELIGIBLE", eligibilityReason: "ELIGIBLE", approvalReason: "KNOWN_APPROVED" },
    ],
    evidence: { pending: [], unknown: [] },
    classification: "LIVE",
    readiness: { allowed: true, basis: "SCHEDULED_END_PASSED" },
    activeSession: false,
  };
}

const fp = (input) => fpLib.computeFinalizationFingerprint(input);

test("18. deterministic: same inputs, any list order, any key order", () => {
  const a = fp(base());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(fp(base()), a);
  const shuffled = base();
  shuffled.records.reverse();
  shuffled.candidates.reverse();
  // Same content, keys inserted in another order.
  shuffled.lecture = { endDate: shuffled.lecture.endDate, date: shuffled.lecture.date, classStatus: "COMPLETED", status: 0, id: "L1" };
  assert.equal(fp(shuffled), a);
  // Equal instants from different Date objects.
  shuffled.lecture.date = new Date(base().lecture.date.getTime());
  assert.equal(fp(shuffled), a);
  assert.equal(fpLib.FINALIZATION_FINGERPRINT_VERSION, 1);
});

test("19-24. every decision-relevant field changes the fingerprint", () => {
  const a = fp(base());
  const cases = {
    "lecture id": (x) => { x.lecture.id = "L2"; },
    "lecture status": (x) => { x.lecture.status = 1; },
    "classStatus": (x) => { x.lecture.classStatus = "SCHEDULED"; },
    "lecture date": (x) => { x.lecture.date = d("2026-09-01T12:31:00Z"); },
    "lecture end": (x) => { x.lecture.endDate = null; },
    "register exists": (x) => { x.register.exists = false; },
    "register version": (x) => { x.register.version = 4; },
    "register start": (x) => { x.register.scheduledStartAt = d("2026-09-01T12:29:00Z"); },
    "register end": (x) => { x.register.scheduledEndAt = null; },
    "grace": (x) => { x.register.graceMinutes = 11; },
    "finalizedAt": (x) => { x.register.finalizedAt = d("2026-09-01T15:00:00Z"); },
    "record version": (x) => { x.records[0].version = 2; },
    "record status": (x) => { x.records[0].status = "PRESENT"; },
    "record source": (x) => { x.records[0].statusSource = "TEACHER"; },
    "record id": (x) => { x.records[0].id = "r9"; },
    "record removed": (x) => { x.records.pop(); },
    "candidate decision": (x) => { x.candidates[0].decision = "MANUAL_REVIEW"; },
    "candidate eligibility": (x) => { x.candidates[0].eligibilityOutcome = "UNKNOWN"; },
    "candidate reason": (x) => { x.candidates[0].eligibilityReason = "NOT_ENROLLED"; },
    "approval reason": (x) => { x.candidates[0].approvalReason = "BROKEN_HISTORY"; },
    "candidate added": (x) => { x.candidates.push({ studentId: "s4", decision: "NOT_ELIGIBLE", eligibilityOutcome: "NOT_ELIGIBLE", eligibilityReason: "NOT_APPROVED", approvalReason: null }); },
    "pending evidence": (x) => { x.evidence.pending.push({ studentId: "s3", earliestEligibleVisitAt: d("2026-09-01T12:40:00Z") }); },
    "unknown evidence": (x) => { x.evidence.unknown.push({ studentId: "s3", earliestUnknownVisitAt: d("2026-09-01T12:40:00Z") }); },
    "classification": (x) => { x.classification = "HISTORICAL"; },
    "readiness basis": (x) => { x.readiness = { allowed: true, basis: "LECTURE_COMPLETED" }; },
    "readiness result": (x) => { x.readiness = { allowed: false, reason: "SCHEDULED_END_NOT_PASSED" }; },
    "active session": (x) => { x.activeSession = true; },
  };
  const seen = new Set([a]);
  for (const [label, mutate] of Object.entries(cases)) {
    const x = base();
    mutate(x);
    const h = fp(x);
    assert.notEqual(h, a, label);
    seen.add(h);
  }
  assert.equal(seen.size, Object.keys(cases).length + 1, "every change gives a distinct fingerprint");
  // Evidence times are part of the representation state.
  const p1 = base(); p1.evidence.pending.push({ studentId: "s3", earliestEligibleVisitAt: d("2026-09-01T12:40:00Z") });
  const p2 = base(); p2.evidence.pending.push({ studentId: "s3", earliestEligibleVisitAt: d("2026-09-01T12:39:00Z") });
  assert.notEqual(fp(p1), fp(p2));
});

test("canonical serializer: sorted keys, explicit nulls, refusals; duplicates refused", () => {
  assert.equal(fpLib.canonicalJson({ b: 1, a: [true, null, "x"], c: d("2026-01-01T00:00:00Z") }), '{"a":[true,null,"x"],"b":1,"c":"2026-01-01T00:00:00.000Z"}');
  for (const bad of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: new Map() }, { a: () => 1 }, { a: new Date("x") }]) {
    assert.throws(() => fpLib.canonicalJson(bad), TypeError);
  }
  const dup = base();
  dup.records.push({ ...dup.records[0] });
  assert.throws(() => fp(dup), /appears twice/);
  const dupCandidate = base();
  dupCandidate.candidates.push({ ...dupCandidate.candidates[0] });
  assert.throws(() => fp(dupCandidate), /appears twice/);
  const missing = base();
  missing.register.finalizedAt = undefined;
  assert.throws(() => fp(missing), TypeError);
});

test("29. the fingerprint is a bare hash; the document holds ids only (never names)", () => {
  const h = fp(base());
  assert.match(h, /^[0-9a-f]{64}$/);
  const doc = fpLib.finalizationFingerprintDocument(base());
  assert.ok(!/name|registration|token|secret|DATABASE/i.test(doc));
  // The domain tag is part of the hash: the bare document hash differs.
  const crypto = require("node:crypto");
  assert.notEqual(crypto.createHash("sha256").update(doc).digest("hex"), h);
});
