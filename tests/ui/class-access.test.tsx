/**
 * Payment-due access control UI: the teacher's "Payment Due Access Control"
 * form (components/class-fee-sheet-panel.tsx) and the student's restriction
 * notice (components/student-portal/class-access-notice.tsx).
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/class-access.test.tsx
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PaymentAccessForm, enableRestrictionWarning, isEnablingRestriction, parseGraceDays } from "../../components/class-fee-sheet-panel";
import { ClassAccessNotice, groupRestrictionsByClass } from "../../components/student-portal/class-access-notice";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};

const form = (over: Partial<Parameters<typeof PaymentAccessForm>[0]> = {}) =>
  renderToStaticMarkup(
    <PaymentAccessForm
      saved={{ restrictUnpaidStudentAccess: false, paymentGracePeriodDays: 5 }}
      enabled={false}
      graceDays="5"
      saving={false}
      error={null}
      onEnabledChange={noop}
      onGraceDaysChange={noop}
      onSave={noop}
      {...over}
    />
  );

const saveButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*Save<\/button>/)?.[0] ?? "";

test("grace days: whole numbers 0 to 30 only", () => {
  assert.equal(parseGraceDays("0"), 0);
  assert.equal(parseGraceDays("5"), 5);
  assert.equal(parseGraceDays(" 30 "), 30);
  for (const bad of ["31", "-1", "2.5", "", "abc", "1e1"]) assert.equal(parseGraceDays(bad), null, bad);
});

test("teacher form: shows the saved state, saves only real changes, validates the grace period", () => {
  const off = form();
  assert.match(text(off), /Payment Due Access Control/);
  assert.match(text(off), /Off: unpaid fees never restrict access to this class\./);
  assert.match(off, /<input type="checkbox"(?![^>]*checked)/);
  assert.match(saveButton(off), / disabled=""/, "nothing changed yet");

  assert.doesNotMatch(saveButton(form({ enabled: true })), / disabled=""/, "toggled: can save");
  assert.doesNotMatch(saveButton(form({ graceDays: "7" })), / disabled=""/, "new grace: can save");

  const invalid = form({ enabled: true, graceDays: "45" });
  assert.match(saveButton(invalid), / disabled=""/);
  assert.match(text(invalid), /Enter a whole number of days from 0 to 30\./);

  const on = form({ saved: { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 3 }, enabled: true, graceDays: "3" });
  assert.match(text(on), /On: students with an unpaid fee lose access .* 3 days after the due date\. Payments stay open\./);

  assert.match(text(form({ saved: null })), /Loading saved settings/);
  assert.match(text(form({ error: "Class not found." })), /Class not found\./);
});

const item = (over: Record<string, unknown> = {}) => ({
  classId: "a",
  className: "Combined Maths",
  feeId: "f1",
  year: 2026,
  month: 11,
  outstandingAmount: 2500,
  dueDate: "2026-11-10T23:59:59.999Z",
  graceEndsAt: "2026-11-15T23:59:59.999Z",
  gracePeriodDays: 5,
  ...over,
});

test("student notice: nothing when not restricted", () => {
  assert.equal(renderToStaticMarkup(<ClassAccessNotice restrictions={[]} />), "");
});

test("student notice: class, month, amount, due date, grace end, reason and the way to pay; one card per class", () => {
  const restrictions = [
    item(),
    item({ feeId: "f2", month: 12, outstandingAmount: 2000, dueDate: "2026-12-10T23:59:59.999Z", graceEndsAt: "2026-12-15T23:59:59.999Z" }),
    item({ classId: "c", className: "Chemistry", feeId: "f3", gracePeriodDays: 0, graceEndsAt: "2026-11-10T23:59:59.999Z" }),
  ];
  assert.equal(groupRestrictionsByClass(restrictions).length, 2);

  const html = renderToStaticMarkup(<ClassAccessNotice restrictions={restrictions} />);
  const t = text(html);
  assert.equal((html.match(/<section/g) ?? []).length, 2, "one card per class");
  assert.match(t, /Combined Maths: class access paused/);
  assert.match(t, /Chemistry: class access paused/);
  assert.match(t, /Nov 2026 · Outstanding Rs\. 2,500 · Due .*10.* · Grace period \(5 days\) ended .*15/);
  assert.match(t, /Dec 2026 · Outstanding Rs\. 2,000/);
  assert.match(t, /Grace period \(0 days\)/);
  assert.match(t, /unpaid after its due date and grace period\. Your other classes are not affected\./);
  assert.match(t, /pay the fee and submit your payment slip/);
  assert.match(html, /href="\/student\/payments\?classId=a"/);
  assert.match(html, /href="\/student\/payments\?classId=c"/);
});

test("enabling the restriction asks first: earlier unpaid months may restrict students immediately", () => {
  // Only switching it ON (from a saved OFF) needs the confirmation.
  assert.equal(isEnablingRestriction({ restrictUnpaidStudentAccess: false, paymentGracePeriodDays: 5 }, true), true);
  assert.equal(isEnablingRestriction({ restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 5 }, true), false, "already on (e.g. only the grace period changes)");
  assert.equal(isEnablingRestriction({ restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 5 }, false), false, "switching off");
  assert.equal(isEnablingRestriction(null, true), false, "not loaded yet (save is disabled anyway)");

  const warning = enableRestrictionWarning(5);
  assert.match(warning, /ANY unpaid fee of this class whose due date plus 5 grace days has passed/);
  assert.match(warning, /immediately/);
  assert.match(warning, /includes earlier months that are still unpaid/);
  assert.match(warning, /payment slip, have a Free Card or owe nothing are not affected/);
  assert.match(enableRestrictionWarning(1), /plus 1 grace day has passed/);
});
