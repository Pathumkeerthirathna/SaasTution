/**
 * Student class-access notice: the initial-payment reason (a public
 * registration's first payment) has its own wording; the overdue wording is
 * unchanged (tests/ui/class-access.test.tsx covers it), including for items
 * without a reason.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ClassAccessNotice } from "../../components/student-portal/class-access-notice";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const item = (over: Record<string, unknown> = {}) => ({
  classId: "a",
  className: "Combined Maths",
  feeId: "f1",
  year: 2026,
  month: 11,
  outstandingAmount: 2000,
  dueDate: "2026-11-14T23:59:59.999Z",
  graceEndsAt: "2026-11-19T23:59:59.999Z",
  gracePeriodDays: 5,
  ...over,
});

test("initial payment: first-payment wording, no due date / grace line, confirmation (not a slip) restores access", () => {
  const html = renderToStaticMarkup(<ClassAccessNotice restrictions={[item({ reason: "INITIAL_PAYMENT" })]} />);
  const t = text(html);
  assert.match(html, /data-restriction-reason="INITIAL_PAYMENT"/);
  assert.match(t, /Combined Maths: first payment required/);
  assert.match(t, /open once your first class fee payment is confirmed by your teacher\. Your other classes are not affected\./);
  assert.match(t, /Nov 2026 · First payment · Outstanding Rs\. 2,000/);
  assert.doesNotMatch(t, /Grace period/);
  assert.doesNotMatch(t, /Access returns as soon as a slip is submitted/);
  assert.match(html, /Go to Payments<\/a>\. Access opens once your teacher confirms the payment \(a submitted slip awaits confirmation\)\./);
  assert.match(html, /href="\/student\/payments\?classId=a"/);
});

test("overdue (or no reason): the original wording, unchanged", () => {
  for (const restriction of [item({ reason: "OVERDUE" }), item()]) {
    const html = renderToStaticMarkup(<ClassAccessNotice restrictions={[restriction]} />);
    const t = text(html);
    assert.match(html, /data-restriction-reason="OVERDUE"/);
    assert.match(t, /Combined Maths: class access paused/);
    assert.match(t, /unpaid after its due date and grace period\. Your other classes are not affected\./);
    assert.match(t, /Grace period \(5 days\) ended/);
    assert.match(html, /Go to Payments<\/a>\. Access returns as soon as a slip is submitted\./);
  }
});

test("one card per class: the initial-payment class and an overdue class each keep their own wording", () => {
  const html = renderToStaticMarkup(
    <ClassAccessNotice
      restrictions={[
        item({ reason: "INITIAL_PAYMENT" }),
        item({ classId: "c", className: "Chemistry", feeId: "f3", reason: "OVERDUE" }),
      ]}
    />
  );
  const t = text(html);
  assert.equal((html.match(/<section/g) ?? []).length, 2);
  assert.match(t, /Combined Maths: first payment required/);
  assert.match(t, /Chemistry: class access paused/);
});
