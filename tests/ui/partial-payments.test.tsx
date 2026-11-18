/**
 * Partial payments, Stage 2A, in the UI: the four Payments-page totals
 * (summarizeFeeRows) through the shared calculation, the teacher's Partial
 * badge, and the student's partly paid fee card.
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/partial-payments.test.tsx
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { PartialBadge, selectableFeeIds, summarizeFeeRows } from "../../components/class-fee-sheet-panel";
import { PaymentCard } from "../../components/student-portal/student-payments-client";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const PANEL = readFileSync(path.join(__dirname, "..", "..", "components", "class-fee-sheet-panel.tsx"), "utf8");

type Status = "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";
const p = (amount: number, status: Status, reversed = false) => ({ amount, status, reversed });
const row = (finalAmount: number, payments: ReturnType<typeof p>[] = [], freeCard = false) => ({ finalAmount, freeCard, payments });

test("totals: full payment unchanged (expected = received = confirmed, nothing due)", () => {
  assert.deepEqual(summarizeFeeRows([row(2500, [p(2500, "CONFIRMED")])], true), { expected: 2500, due: 0, received: 2500, confirmed: 2500 });
});

test("totals: several partial payments add up; the rest is Due after the due date", () => {
  const partial = row(2500, [p(500, "CONFIRMED"), p(1000, "CONFIRMED")]);
  assert.deepEqual(summarizeFeeRows([partial], true), { expected: 2500, due: 1000, received: 1500, confirmed: 1500 });
  assert.equal(summarizeFeeRows([partial], false).due, 0, "not Due before the due date");
});

test("totals: pending and clarification slips are received (submitted) but never confirmed, and never Due", () => {
  for (const status of ["PENDING", "NEEDS_CLARIFICATION"] as const) {
    assert.deepEqual(summarizeFeeRows([row(2500, [p(2500, status)])], true), { expected: 2500, due: 0, received: 2500, confirmed: 0 }, status);
  }
  // A slip for the rest of a partly paid fee.
  assert.deepEqual(summarizeFeeRows([row(2500, [p(1000, "PENDING"), p(1500, "CONFIRMED")])], true), { expected: 2500, due: 0, received: 2500, confirmed: 1500 });
});

test("totals: a reversed payment is not received; the fee is owed again", () => {
  assert.deepEqual(summarizeFeeRows([row(2500, [p(2500, "CONFIRMED", true)])], true), { expected: 2500, due: 2500, received: 0, confirmed: 0 });
});

test("totals: Free Card and zero payable add nothing; an overpayment is confirmed money", () => {
  assert.deepEqual(summarizeFeeRows([row(0, [], true), row(0)], true), { expected: 0, due: 0, received: 0, confirmed: 0 });
  assert.deepEqual(summarizeFeeRows([row(2500, [p(1000, "CONFIRMED"), p(2000, "CONFIRMED")])], true), { expected: 2500, due: 0, received: 3000, confirmed: 3000 });
});

test("teacher view: Partial badge with the remaining amount; a partly paid row stays locked and out of Free Card selection", () => {
  assert.match(text(renderToStaticMarkup(<PartialBadge outstanding={1000} />)), /Partial · Rs\. 1,000 due/);
  assert.match(text(renderToStaticMarkup(<PartialBadge outstanding={null} />)), /^Partial$/);
  assert.deepEqual(selectableFeeIds([{ feeId: "a", paymentStatus: "PARTIAL" }, { feeId: "b", paymentStatus: "UNPAID" }]), ["b"]);
  assert.equal((PANEL.match(/const paidLocked = row\.paymentStatus === "PAID" \|\| row\.paymentStatus === "PARTIAL";/g) ?? []).length, 2, "both layouts");
  assert.equal((PANEL.match(/row\.paymentStatus === "PARTIAL" \? \(\s*<PartialBadge outstanding=\{row\.paymentSummary\?\.outstanding \?\? null\} \/>/g) ?? []).length, 2, "both layouts");
});

const feeItem = (over: Record<string, unknown>) => ({
  feeId: "f1", classId: "c1", className: "Maths", teacherName: "Teacher", year: 2026, month: 12,
  dueDate: "2026-12-14T23:59:59.999Z", amount: 2500, discount: 0, lateJoinDeduct: 0, waiverAmount: 0, finalAmount: 2500,
  state: "UNPAID" as const, payment: null, ...over,
});

test("student card: partly paid shows paid so far, the outstanding balance and no slip button (uploads unchanged in 2A)", () => {
  const html = text(renderToStaticMarkup(
    <PaymentCard fee={{ ...feeItem({ paidAmount: 1500, outstanding: 1000 }), state: "PARTIAL" }} onSubmit={() => {}} />
  ));
  assert.match(html, /Partly paid/);
  assert.match(html, /Paid so far Rs 1,500/);
  assert.match(html, /Outstanding Rs 1,000/);
  assert.match(html, /Please pay the outstanding Rs 1,000 to your teacher/);
  assert.doesNotMatch(html, /Submit payment slip|Re-submit slip/);
});

test("student card: an unpaid fee is unchanged", () => {
  const html = text(renderToStaticMarkup(<PaymentCard fee={feeItem({})} onSubmit={() => {}} />));
  assert.match(html, /To pay/);
  assert.match(html, /Submit payment slip/);
  assert.doesNotMatch(html, /Partly paid|Outstanding/);
});
