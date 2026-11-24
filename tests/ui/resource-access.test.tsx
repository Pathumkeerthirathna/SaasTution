/*
 * Monthly resource access UI: the student notice (one card per class, the
 * exact locked months), the Payments page "Resource access" panel (payment
 * status, amounts, grace period, override source, effective access) and the
 * locked-resource badge that replaces view / download controls.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ResourceAccessNotice, type ResourceAccessNoticeMonth } from "../../components/student-portal/class-access-notice";
import { LockedResourceBadge, isResourceLocked } from "../../components/student-portal/locked-resource";
import {
  ResourceAccessPanel,
  choiceOf,
  gracePeriodText,
  resourceAccessSourceText,
  type ResourceAccessDecisionView,
  type ResourceAccessViewData,
} from "../../components/resource-access-dialog";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const month = (over: Partial<ResourceAccessNoticeMonth> = {}): ResourceAccessNoticeMonth => ({
  classId: "a",
  className: "Combined Maths",
  year: 2026,
  month: 10,
  locked: true,
  source: "UNPAID",
  paymentStatus: "UNPAID",
  outstandingAmount: 2000,
  dueDate: "2026-10-14T23:59:59.999Z",
  graceEndsAt: "2026-10-19T23:59:59.999Z",
  graceActive: false,
  gracePeriodDays: 5,
  ...over,
});

test("student notice: nothing when no month is locked or in grace", () => {
  assert.equal(renderToStaticMarkup(<ResourceAccessNotice months={[]} />), "");
});

test("student notice: one card per class naming the exact locked months, amounts, grace status; a pending slip never unlocks", () => {
  const html = renderToStaticMarkup(
    <ResourceAccessNotice
      months={[
        month(),
        month({ month: 11, locked: false, source: "GRACE", graceActive: true, dueDate: "2026-11-21T23:59:59.999Z", graceEndsAt: "2026-11-26T23:59:59.999Z" }),
        month({ classId: "c", className: "Chemistry", month: 9, paymentStatus: "PARTIAL", outstandingAmount: 500, gracePeriodDays: 0 }),
        month({ classId: "c", className: "Chemistry", month: 8, source: "OVERRIDE_REVOKED", paymentStatus: "PAID", outstandingAmount: 0 }),
      ]}
    />
  );
  const t = text(html);
  assert.equal((html.match(/<section/g) ?? []).length, 2, "one card per class");
  assert.match(t, /Combined Maths: resources locked for October 2026/);
  assert.doesNotMatch(t, /Combined Maths: resources locked for [^.]*November/, "a month in grace is not listed as locked");
  assert.match(t, /October 2026 · Locked · Unpaid · Outstanding Rs\. 2,000 · Grace period \(5 days\) ended/);
  assert.match(t, /November 2026 · Open · Outstanding Rs\. 2,000 · Grace period \(5 days\) active until .*26.* · Resources stay open until then/);
  assert.match(t, /Chemistry: resources locked for September 2026, August 2026/);
  assert.match(t, /September 2026 · Locked · Partly paid · Outstanding Rs\. 500 · Grace period \(0 days\) ended/);
  assert.match(t, /August 2026 · Locked · Locked by your teacher/);
  assert.match(t, /Resources of your paid months and of your other classes are not affected\./);
  assert.match(t, /A submitted slip does not unlock resources/);
  assert.match(html, /href="\/student\/payments\?classId=a"/);
  assert.match(html, /href="\/student\/payments\?classId=c"/);
  assert.match(html, /data-resource-month="2026-10" data-locked="true"/);
  assert.match(html, /data-resource-month="2026-11" data-locked="false"/);
});

test("student notice: the initial payment of a public registration", () => {
  const t = text(renderToStaticMarkup(<ResourceAccessNotice months={[month({ month: 11, source: "INITIAL_PAYMENT", graceEndsAt: null })]} />));
  assert.match(t, /November 2026 · Locked · First payment · Outstanding Rs\. 2,000 · Opens once your teacher confirms the payment/);
});

test("locked badge: the month, a payment link, and no file link", () => {
  const html = renderToStaticMarkup(<LockedResourceBadge lock={{ locked: true, year: 2026, month: 10 }} classId="a" />);
  assert.match(text(html), /Locked: payment required for October 2026 Pay/);
  assert.match(html, /data-locked-resource="2026-10"/);
  assert.match(html, /href="\/student\/payments\?classId=a"/);
  assert.doesNotMatch(html, /\/api\//);
  assert.match(text(renderToStaticMarkup(<LockedResourceBadge lock={{ locked: true, year: 2026, month: 3 }} compact />)), /^Locked · March 2026$/);
  assert.equal(isResourceLocked({ access: { locked: true, year: 2026, month: 1 } }), true);
  assert.equal(isResourceLocked({ access: { locked: false, year: 2026, month: 1 } }), false);
  assert.equal(isResourceLocked(null), false);
});

const decision = (over: Partial<ResourceAccessDecisionView> = {}): ResourceAccessDecisionView => ({
  classId: "a",
  className: "Combined Maths",
  year: 2026,
  month: 10,
  accessible: false,
  source: "UNPAID",
  override: null,
  restrictionEnabled: true,
  gracePeriodDays: 5,
  fee: {
    paymentStatus: "PARTIAL",
    finalAmount: 2000,
    confirmedTotal: 1500,
    outstanding: 500,
    awaitingTotal: 500,
    dueDate: "2026-10-14T23:59:59.999Z",
    graceEndsAt: "2026-10-19T23:59:59.999Z",
    graceActive: false,
    initialPayment: false,
  },
  ...over,
});
const data = (d: ResourceAccessDecisionView): ResourceAccessViewData => ({
  student: { id: "s1", name: "Nimal Perera", registrationNumber: "S001" },
  class: { id: "a", name: "Combined Maths" },
  decision: d,
});
const noop = () => {};

test("teacher panel: student, class, month, payment status, confirmed / outstanding amounts, grace period, source and effective access", () => {
  const html = renderToStaticMarkup(
    <ResourceAccessPanel data={data(decision())} choice="DEFAULT" busy={false} message={null} onChoose={noop} onSave={noop} onCancel={noop} />
  );
  const t = text(html);
  assert.match(t, /Student Nimal Perera \(S001\)/);
  assert.match(t, /Class Combined Maths/);
  assert.match(t, /Resource month October 2026/);
  assert.match(t, /Payment status Partly paid/);
  assert.match(t, /Confirmed amount Rs\. 1,500/);
  assert.match(t, /Outstanding amount Rs\. 500/);
  assert.match(t, /Grace period Ended \(5 days\)/);
  assert.match(t, /Effective access: Locked/);
  assert.match(t, /Automatic: unpaid after the grace period/);
  assert.match(t, /A submitted slip \(Rs\. 500\) does not unlock resources until you confirm it\./);
  assert.match(html, /data-effective-access="LOCKED"/);
  for (const label of ["Automatic \\(default\\)", "Grant access", "Revoke access"]) assert.match(t, new RegExp(label));
  assert.match(html, /<button type="button" disabled="" class="[^"]*">Save<\/button>/, "nothing to save until the choice changes");
});

test("teacher panel: an override shows as the source; changing the choice enables Save; errors are shown", () => {
  const granted = decision({ accessible: true, source: "OVERRIDE_GRANTED", override: "GRANTED" });
  assert.equal(choiceOf(granted), "GRANTED");
  const html = renderToStaticMarkup(
    <ResourceAccessPanel data={data(granted)} choice="DEFAULT" busy={false} message="Could not save resource access." onChoose={noop} onSave={noop} onCancel={noop} />
  );
  const t = text(html);
  assert.match(t, /Effective access: Unlocked/);
  assert.match(t, /Teacher override: access granted/);
  assert.match(html, /role="alert"[^>]*>Could not save resource access\./);
  assert.doesNotMatch(html, /<button type="button" disabled=""[^>]*>Save/, "the choice differs: Save enabled");
  assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="DEFAULT"/);
});

test("teacher panel: grace period wording for every case; source texts", () => {
  assert.equal(gracePeriodText(decision({ fee: null })), "No fee for this month");
  assert.equal(gracePeriodText(decision({ fee: { ...decision().fee!, outstanding: 0 } })), "Not applicable (nothing outstanding)");
  assert.equal(gracePeriodText(decision({ fee: { ...decision().fee!, initialPayment: true } })), "None (first payment of a public registration)");
  assert.match(gracePeriodText(decision({ fee: { ...decision().fee!, graceActive: true } })), /^Active \(5 days\) until /);
  assert.equal(resourceAccessSourceText("PRE_ENROLMENT"), "Automatic: before the student joined the class");
  assert.equal(resourceAccessSourceText("SETTING_OFF"), "Automatic: the class restriction is off");
  const pre = text(
    renderToStaticMarkup(
      <ResourceAccessPanel data={data(decision({ fee: null, source: "PRE_ENROLMENT", month: 8 }))} choice="DEFAULT" busy={false} message={null} onChoose={noop} onSave={noop} onCancel={noop} />
    )
  );
  assert.match(pre, /Payment status No fee for this month/);
  assert.match(pre, /Confirmed amount - Outstanding amount -/);
  assert.match(pre, /Resource month August 2026/);
});
