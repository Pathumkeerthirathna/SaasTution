/**
 * Class-level Free Card eligibility, Stage 3B: the teacher's Students panel
 * (components/class-management-panel.tsx) selection, bulk actions, optional
 * current-month apply and result notices (components/free-card-eligibility-actions.tsx).
 * Pure helpers, a fake fetch and static rendering (no DOM).
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/free-card-eligibility.test.tsx
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  allEnrolmentsSelected,
  buildEligibilityRequest,
  EligibilityConfirmDialog,
  EligibilityNoticeView,
  eligibilityNotice,
  eligibilityPanelReducer,
  EligibilitySelectionBar,
  EnrolmentCheckbox,
  FreeCardStudentBadge,
  initialEligibilityPanelState,
  selectableEnrolmentIds,
  shouldRefreshAfter,
  submitFreeCardEligibility,
  type EligibilityPanelState,
  type SelectableEnrolment,
} from "../../components/free-card-eligibility-actions";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const ROOT = path.join(__dirname, "..", "..");
const PANEL = readFileSync(path.join(ROOT, "components", "class-management-panel.tsx"), "utf8");
const CLASS_SERVICE = readFileSync(path.join(ROOT, "services", "class-service.ts"), "utf8");

// ---- fixtures ---------------------------------------------------------------------------------

const E1 = "00000000-0000-4000-8000-000000000101";
const E2 = "00000000-0000-4000-8000-000000000102";
const E3 = "00000000-0000-4000-8000-000000000103";
const OLD = "00000000-0000-4000-8000-000000000199";

const enrolments: SelectableEnrolment[] = [
  { id: E1, isActive: true },
  { id: E2, isActive: true, freeCardEligible: true },
  { id: E3, isActive: true },
  { id: OLD, isActive: false, freeCardEligible: true }, // a removed (past) enrolment
];

const run = (events: Parameters<typeof eligibilityPanelReducer>[1][], start = initialEligibilityPanelState()) =>
  events.reduce<EligibilityPanelState>((state, event) => eligibilityPanelReducer(state, event), start);
const ids = (state: EligibilityPanelState) => [...state.selected].sort();

type Call = { url: string; method?: string; body: Record<string, unknown> };
type Reply = { status: number; json?: unknown } | "network-error" | { status: number; text: string };

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    if ("text" in reply) return new Response(reply.text, { status: reply.status });
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, impl };
}

const savedData = (eligible: boolean, apply: unknown = null) => ({
  classId: "class-1",
  eligible,
  enrolments: [
    { classStudentId: E1, studentId: "s1", freeCardEligible: eligible },
    { classStudentId: E3, studentId: "s3", freeCardEligible: eligible },
  ],
  changedCount: 2,
  apply,
});
const saved = (message: string, data: unknown) => ({ status: 200, json: { success: true, data, message } });
const refused = (status: number, code: string, message: string) => ({
  status,
  json: { success: false, error: { code, message } },
});

// ---- 1. selection -----------------------------------------------------------------------------

test("selection: one and several students, by enrolment id; toggling again unselects", () => {
  let state = run([{ type: "toggle", enrolment: enrolments[0] }]);
  assert.deepEqual(ids(state), [E1]);

  state = run([{ type: "toggle", enrolment: enrolments[2] }, { type: "toggle", enrolment: enrolments[1] }], state);
  assert.deepEqual(ids(state), [E1, E2, E3]);

  state = run([{ type: "toggle", enrolment: enrolments[1] }], state);
  assert.deepEqual(ids(state), [E1, E3]);
});

test("selection: a removed (inactive) enrolment can never be selected", () => {
  const state = run([{ type: "toggle", enrolment: enrolments[3] }, { type: "toggleAll", enrolments }]);
  assert.ok(!state.selected.has(OLD));
  assert.deepEqual(selectableEnrolmentIds(enrolments), [E1, E2, E3]);
});

test("select all: every displayed active student; again: none; partial selection completes", () => {
  let state = run([{ type: "toggleAll", enrolments }]);
  assert.deepEqual(ids(state), [E1, E2, E3]);
  assert.equal(allEnrolmentsSelected(state.selected, enrolments), true);

  state = run([{ type: "toggleAll", enrolments }], state);
  assert.deepEqual(ids(state), []);
  assert.equal(allEnrolmentsSelected(state.selected, enrolments), false);

  state = run([{ type: "toggle", enrolment: enrolments[0] }, { type: "toggleAll", enrolments }], state);
  assert.deepEqual(ids(state), [E1, E2, E3], "a partial selection becomes all");
  assert.equal(allEnrolmentsSelected(new Set(), []), false, "nothing to select: never 'all selected'");
});

test("selection is cleared on class switch and panel close (reset on every studentsPanelClassId change)", () => {
  const state = run([
    { type: "toggleAll", enrolments },
    { type: "confirm", action: "enable" },
    { type: "setApply", value: true },
    { type: "reset" },
  ]);
  assert.deepEqual(state, initialEligibilityPanelState());

  // Wiring in the panel: one reset effect keyed on the open class id, which
  // becomes another id on a class switch and null when the panel closes.
  assert.match(PANEL, /useEffect\(\(\) => \{\s*dispatchEligibility\(\{ type: "reset" \}\);\s*\}, \[studentsPanelClassId\]\);/);
  assert.match(PANEL, /onClick=\{\(\) => setStudentsPanelClassId\(null\)\}/, "closing sets the id to null");
});

test("after a reload, enrolments that are no longer active drop out of the selection", () => {
  const state = run([
    { type: "toggleAll", enrolments },
    { type: "sync", enrolments: [{ id: E1, isActive: true }, { id: E2, isActive: false }, { id: E3, isActive: true }] },
  ]);
  assert.deepEqual(ids(state), [E1, E3]);
  assert.match(PANEL, /dispatchEligibility\(\{ type: "sync", enrolments: studentsPanelActiveStudents \}\);/);
});

// ---- 2-3. actions, optional apply, request ------------------------------------------------------

test("Mark as Free Card Students: the apply option starts unchecked every time; only enable can set it", () => {
  let state = run([{ type: "toggle", enrolment: enrolments[0] }, { type: "confirm", action: "enable" }]);
  assert.equal(state.confirming, "enable");
  assert.equal(state.applyToCurrentMonth, false, "default: unchecked");

  state = run([{ type: "setApply", value: true }], state);
  assert.equal(state.applyToCurrentMonth, true);

  state = run([{ type: "cancel" }, { type: "confirm", action: "enable" }], state);
  assert.equal(state.applyToCurrentMonth, false, "reopened: unchecked again");
  assert.deepEqual(ids(state), [E1], "cancel keeps the selection");

  state = run([{ type: "cancel" }, { type: "confirm", action: "disable" }, { type: "setApply", value: true }], state);
  assert.equal(state.confirming, "disable");
  assert.equal(state.applyToCurrentMonth, false, "never for removal");

  assert.equal(run([{ type: "confirm", action: "enable" }]).confirming, null, "nothing selected: no dialog");
});

test("request payloads: the Stage 3A contract; applyToCurrentMonth only when explicitly chosen", () => {
  assert.deepEqual(buildEligibilityRequest(new Set([E1, E3]), "enable", false), { classStudentIds: [E1, E3], eligible: true });
  assert.deepEqual(buildEligibilityRequest([E1, E3], "enable", true), {
    classStudentIds: [E1, E3],
    eligible: true,
    applyToCurrentMonth: true,
  });
  assert.deepEqual(buildEligibilityRequest([E1], "disable", true), { classStudentIds: [E1], eligible: false }, "never for removal");
  assert.deepEqual(buildEligibilityRequest([E1, E1], "disable", false), { classStudentIds: [E1], eligible: false }, "unique ids");
});

test("marking eligibility: POST /api/classes/[id]/free-card-eligibility; success clears the selection and refreshes", async () => {
  const { calls, impl } = fakeFetch([saved("Free Card eligibility enabled for 2 students.", savedData(true))]);

  const outcome = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1, E3], "enable", false), impl);

  assert.deepEqual(calls, [
    { url: "/api/classes/class-1/free-card-eligibility", method: "POST", body: { classStudentIds: [E1, E3], eligible: true } },
  ]);
  assert.equal(outcome.kind, "saved");
  assert.equal(shouldRefreshAfter(outcome), true);
  const notice = eligibilityNotice(outcome);
  assert.deepEqual(notice, { tone: "success", message: "Free Card eligibility enabled for 2 students." });

  const state = run([{ type: "toggle", enrolment: enrolments[0] }, { type: "confirm", action: "enable" }, { type: "saved", notice }]);
  assert.deepEqual(ids(state), [], "cleared after a successful bulk operation");
  assert.equal(state.confirming, null);
  assert.deepEqual(state.notice, notice);
});

test("removing eligibility: eligible false, no apply flag, the API's message shown", async () => {
  const message = "Free Card eligibility disabled for 2 students. Existing Free Cards were not changed.";
  const { calls, impl } = fakeFetch([saved(message, savedData(false))]);

  const outcome = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1, E3], "disable", false), impl);

  assert.deepEqual(calls[0].body, { classStudentIds: [E1, E3], eligible: false });
  assert.deepEqual(eligibilityNotice(outcome), { tone: "success", message });
  assert.equal(shouldRefreshAfter(outcome), true);
});

test("apply requested and done: the issued / skipped result is shown", async () => {
  const message = "Free Card eligibility enabled for 2 students. 1 Free Card issued for this month, 1 skipped.";
  const apply = {
    status: "APPLIED",
    processed: [{ feeId: "f1", studentName: "Nimal" }],
    skipped: [{ feeId: "f3", studentName: "Kamal", reason: "PENDING_PAYMENT", message: "A payment slip is waiting for your confirmation." }],
  };
  const { calls, impl } = fakeFetch([saved(message, savedData(true, apply))]);

  const outcome = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1, E3], "enable", true), impl);

  assert.equal(calls[0].body.applyToCurrentMonth, true);
  assert.deepEqual(eligibilityNotice(outcome), {
    tone: "success",
    message,
    details: ["Kamal: A payment slip is waiting for your confirmation."],
  });
});

// ---- 4. apply failure, refusals, network --------------------------------------------------------

test("apply failed AFTER the save: a warning with the API's message, selection cleared, list refreshed (never 'failed' / rolled back)", async () => {
  const message =
    "Free Card eligibility enabled for 2 students. The eligibility change was saved and has not been reverted, but applying Free Cards to this month's fees failed: These fees are being changed by another request. Please try again.";
  const apply = { status: "FAILED", code: "FREE_CARD_BUSY", message: "These fees are being changed by another request. Please try again." };
  const { impl } = fakeFetch([saved(message, savedData(true, apply))]);

  const outcome = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1, E3], "enable", true), impl);

  assert.equal(outcome.kind, "saved");
  assert.equal(outcome.kind === "saved" && outcome.applyFailed, true);
  const notice = eligibilityNotice(outcome);
  assert.equal(notice.tone, "warning", "not an error: the eligibility change succeeded");
  assert.equal(notice.message, message, "the API's own message");
  assert.equal(shouldRefreshAfter(outcome), true);

  const state = run([{ type: "toggleAll", enrolments }, { type: "confirm", action: "enable" }, { type: "saved", notice }]);
  assert.deepEqual(ids(state), [], "treated as a successful save");

  const html = text(renderToStaticMarkup(<EligibilityNoticeView notice={notice} onDismiss={() => {}} />));
  assert.match(html, /has not been reverted/);
  assert.doesNotMatch(html, /rolled back|could not be saved|was not saved|Nothing was changed/i);
});

test("busy (409 FREE_CARD_ELIGIBILITY_BUSY) and validation (400): an error, nothing changed, selection kept, no refresh", async () => {
  const { impl } = fakeFetch([
    refused(409, "FREE_CARD_ELIGIBILITY_BUSY", "These students are being changed by another request. Please try again."),
    refused(400, "VALIDATION_ERROR", "Select at most 500 students at a time."),
  ]);

  for (const expected of [
    "These students are being changed by another request. Please try again. Nothing was changed.",
    "Select at most 500 students at a time. Nothing was changed.",
  ]) {
    const outcome = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1], "enable", false), impl);
    assert.equal(outcome.kind, "refused");
    assert.equal(shouldRefreshAfter(outcome), false);
    const notice = eligibilityNotice(outcome);
    assert.deepEqual(notice, { tone: "error", message: expected });

    const state = run([{ type: "toggle", enrolment: enrolments[0] }, { type: "confirm", action: "enable" }, { type: "failed", notice }]);
    assert.deepEqual(ids(state), [E1], "kept for a retry");
    assert.equal(state.confirming, null);
  }
});

test("inactive (409 ENROLMENT_NOT_ACTIVE) or unknown enrolments: an error and a list refresh", async () => {
  const { impl } = fakeFetch([
    refused(409, "ENROLMENT_NOT_ACTIVE", "Some selected students are no longer active in this class."),
    refused(404, "ENROLMENT_NOT_FOUND", "Some selected students are not enrolled in this class."),
  ]);

  const inactive = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1], "enable", false), impl);
  assert.equal(shouldRefreshAfter(inactive), true);
  assert.deepEqual(eligibilityNotice(inactive), {
    tone: "error",
    message: "Some selected students are no longer active in this class. Nothing was changed. The list has been refreshed.",
  });

  const unknown = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1], "enable", false), impl);
  assert.equal(shouldRefreshAfter(unknown), true);
  assert.equal(eligibilityNotice(unknown).tone, "error");
});

test("network and unexpected errors: an error that never claims success or a rollback; the list is refreshed", async () => {
  const { impl } = fakeFetch(["network-error", { status: 500, json: { success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." } } }, { status: 502, text: "<html>Bad gateway</html>" }]);

  const network = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1], "enable", false), impl);
  assert.equal(network.kind, "network");
  assert.equal(shouldRefreshAfter(network), true, "unknown outcome: show what was saved");
  assert.match(eligibilityNotice(network).message, /may not have been saved/);

  for (const status of [500, 502]) {
    const outcome = await submitFreeCardEligibility("class-1", buildEligibilityRequest([E1], "enable", false), impl);
    assert.deepEqual(outcome, { kind: "unexpected", status });
    assert.equal(eligibilityNotice(outcome).tone, "error");
    assert.equal(shouldRefreshAfter(outcome), true);
  }
});

// ---- 5. indicators and rendering ----------------------------------------------------------------

test("indicator: 'Free Card Student' only for an eligible enrolment", () => {
  assert.equal(text(renderToStaticMarkup(<FreeCardStudentBadge eligible={true} />)), "Free Card Student");
  assert.equal(renderToStaticMarkup(<FreeCardStudentBadge eligible={false} />), "");
  assert.equal(renderToStaticMarkup(<FreeCardStudentBadge eligible={undefined} />), "");
});

test("indicator comes from the enrolment (ClassStudent.freeCardEligible), never from fee Free Cards", () => {
  assert.match(CLASS_SERVICE, /freeCardEligible: true,/, "the class list returns the enrolment's flag");
  assert.match(PANEL, /<FreeCardStudentBadge eligible=\{entry\.freeCardEligible\} \/>/);
  assert.doesNotMatch(PANEL, /freeCard\b(?!Eligible|Student)/, "no fee-level freeCard read in the panel");
});

test("the panel: checkboxes by enrolment id in the Active list only, select-all over active students, dialog wired", () => {
  const active = PANEL.indexOf("{/* Active Students */}");
  const past = PANEL.indexOf("{/* Past Students */}");
  assert.ok(active > 0 && past > active);
  const checkbox = PANEL.indexOf("<EnrolmentCheckbox");
  assert.ok(checkbox > active && checkbox < past, "the row checkbox is in the Active list");
  assert.equal(PANEL.split("<EnrolmentCheckbox").length - 1, 1, "and nowhere else (not for past enrolments)");
  assert.match(PANEL, /checked=\{eligibility\.selected\.has\(entry\.id\)\}/, "selected by ClassStudent id");
  assert.match(PANEL, /dispatchEligibility\(\{ type: "toggleAll", enrolments: studentsPanelActiveStudents \}\)/);
  assert.match(PANEL, /buildEligibilityRequest\(eligibility\.selected, action, eligibility\.applyToCurrentMonth\)/);
  assert.match(PANEL, /if \(shouldRefreshAfter\(outcome\)\) await loadClasses\(page\);/);
});

test("selection bar: select-all always; both actions once something is selected", () => {
  const props = { selectableCount: 3, busy: false, onToggleAll() {}, onMark() {}, onRemove() {}, onClear() {} };

  const none = text(renderToStaticMarkup(<EligibilitySelectionBar {...props} selectedCount={0} allSelected={false} />));
  assert.match(none, /Select All/);
  assert.doesNotMatch(none, /Mark as Free Card Students|Remove Free Card Eligibility/);

  const some = renderToStaticMarkup(<EligibilitySelectionBar {...props} selectedCount={2} allSelected={false} />);
  assert.match(text(some), /2 selected/);
  assert.match(text(some), /Mark as Free Card Students/);
  assert.match(text(some), /Remove Free Card Eligibility/);

  const all = renderToStaticMarkup(<EligibilitySelectionBar {...props} selectedCount={3} allSelected={true} />);
  assert.match(all, /checked=""/);
  assert.equal(renderToStaticMarkup(<EligibilitySelectionBar {...props} selectableCount={0} selectedCount={0} allSelected={false} />), "", "no active students: nothing to select");

  const row = renderToStaticMarkup(<EnrolmentCheckbox checked={true} disabled={false} studentName="Nimal" onToggle={() => {}} />);
  assert.match(row, /aria-label="Select Nimal"/);
  assert.match(row, /checked=""/);
});

test("confirmation: the apply checkbox is shown (unchecked) for marking only", () => {
  const common = { count: 2, className: "Maths", busy: false, onApplyChange() {}, onCancel() {}, onConfirm() {} };

  const enable = renderToStaticMarkup(<EligibilityConfirmDialog {...common} action="enable" applyToCurrentMonth={false} />);
  assert.match(text(enable), /Also apply Free Cards to this month's existing eligible fees/);
  assert.match(text(enable), /2 students in Maths will get a Free Card automatically/);
  assert.equal((enable.match(/type="checkbox"/g) ?? []).length, 1);
  assert.doesNotMatch(enable, /checked=""/, "unchecked by default");

  const checked = renderToStaticMarkup(<EligibilityConfirmDialog {...common} action="enable" applyToCurrentMonth={true} />);
  assert.match(checked, /checked=""/);

  const disable = text(renderToStaticMarkup(<EligibilityConfirmDialog {...common} action="disable" applyToCurrentMonth={false} />));
  assert.doesNotMatch(disable, /Also apply Free Cards/);
  assert.match(disable, /Free Cards already issued stay as they are/);
});

// ---- 6. manual Free Card controls untouched ----------------------------------------------------

test("the manual per-fee Free Card controls are not part of this change", () => {
  const sheet = readFileSync(path.join(ROOT, "components", "class-fee-sheet-panel.tsx"), "utf8");
  assert.doesNotMatch(sheet, /free-card-eligibility/, "the fee sheet does not use the eligibility API");
  assert.match(sheet, /\/api\/payments\/fees\/free-cards/, "the manual issue / revoke API is still used there");
  assert.doesNotMatch(PANEL, /\/api\/payments\/fees\/free-cards/, "the Students panel never issues cards directly");
});
