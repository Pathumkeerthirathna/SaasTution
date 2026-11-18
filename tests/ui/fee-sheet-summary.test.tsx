/**
 * Teacher Payments page (/dashboard/payments): the Expected / Due / Received /
 * Confirmed amounts of components/class-fee-sheet-panel.tsx, the All classes
 * totals and the stale-response guard. Pure functions and react-dom/server
 * renders; no browser, no server.
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/fee-sheet-summary.test.tsx
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EMPTY_FEE_SUMMARY,
  FeeSummaryAmounts,
  addFeeSummaries,
  isLatestSheetRequestId,
  sheetMatchesSelection,
  summarizeFeeRows,
} from "../../components/class-fee-sheet-panel";

type Status = "PENDING" | "CONFIRMED" | "NEEDS_CLARIFICATION";

const ROOT = path.join(__dirname, "..", "..");
const SOURCE = readFileSync(path.join(ROOT, "components", "class-fee-sheet-panel.tsx"), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const pay = (amount: number, status: Status) => ({ amount, status });
const row = (finalAmount: number, ...payments: { amount: number; status: Status }[]) => ({
  finalAmount,
  payments,
});

// The example from the requirements: Rs. 60,000 confirmed, Rs. 30,000 awaiting
// confirmation (pending or clarification), Rs. 63,000 with no slip.
const EXAMPLE = [
  row(25000, pay(25000, "CONFIRMED")),
  row(35000, pay(35000, "CONFIRMED")),
  row(20000, pay(20000, "PENDING")),
  row(10000, pay(10000, "NEEDS_CLARIFICATION")),
  row(30000),
  row(33000),
];

test("the requirements example after the due date: 153,000 / 63,000 / 90,000 / 60,000", () => {
  assert.deepEqual(summarizeFeeRows(EXAMPLE, true), {
    expected: 153000,
    due: 63000,
    received: 90000,
    confirmed: 60000,
  });
});

test("1. before the due date Due is zero and the other amounts are unchanged", () => {
  assert.deepEqual(summarizeFeeRows(EXAMPLE, false), {
    expected: 153000,
    due: 0,
    received: 90000,
    confirmed: 60000,
  });
});

test("2. after the due date with no submissions every final amount is Due", () => {
  const summary = summarizeFeeRows([row(5000), row(4500), row(0)], true);
  assert.deepEqual(summary, { expected: 9500, due: 9500, received: 0, confirmed: 0 });
});

test("3. PENDING submissions count as Received but not Due", () => {
  const summary = summarizeFeeRows([row(5000, pay(5000, "PENDING")), row(4000)], true);
  assert.deepEqual(summary, { expected: 9000, due: 4000, received: 5000, confirmed: 0 });
});

test("4. NEEDS_CLARIFICATION submissions count as Received but not Due", () => {
  const summary = summarizeFeeRows([row(5000, pay(5000, "NEEDS_CLARIFICATION")), row(4000)], true);
  assert.deepEqual(summary, { expected: 9000, due: 4000, received: 5000, confirmed: 0 });
});

test("5. CONFIRMED payments count in Received and Confirmed, never in Due", () => {
  const summary = summarizeFeeRows([row(5000, pay(5000, "CONFIRMED"))], true);
  assert.deepEqual(summary, { expected: 5000, due: 0, received: 5000, confirmed: 5000 });
});

test("6. a student with no submission is never Received, and is Due only after the due date", () => {
  assert.equal(summarizeFeeRows([row(7000)], false).received, 0);
  assert.equal(summarizeFeeRows([row(7000)], false).due, 0);
  assert.equal(summarizeFeeRows([row(7000)], true).due, 7000);
  assert.deepEqual(summarizeFeeRows([row(7000, ...[])], true), { expected: 7000, due: 7000, received: 0, confirmed: 0 });
});

test("7. several payment records on one fee count once: the confirmed one, else the latest", () => {
  // Newest first, as the fee sheet API returns them.
  const confirmedOlder = row(5000, pay(4800, "PENDING"), pay(5000, "CONFIRMED"));
  assert.deepEqual(summarizeFeeRows([confirmedOlder], true), {
    expected: 5000,
    due: 0,
    received: 5000,
    confirmed: 5000,
  });

  // Partial payments (approved, Stage 2A): every confirmed payment is received
  // money, so two confirmed payments add up (here an overpayment, reported as
  // such by lib/fee-payment-state.ts) instead of one being ignored.
  const twoConfirmed = row(5000, pay(5000, "CONFIRMED"), pay(5000, "CONFIRMED"));
  assert.deepEqual(summarizeFeeRows([twoConfirmed], true), {
    expected: 5000,
    due: 0,
    received: 10000,
    confirmed: 10000,
  });

  const latestPending = row(5000, pay(4500, "PENDING"), pay(5000, "NEEDS_CLARIFICATION"));
  assert.equal(summarizeFeeRows([latestPending], true).received, 4500);
});

test("Confirmed uses the confirmed payment's own amount, not the fee's finalAmount", () => {
  const summary = summarizeFeeRows([row(5000, pay(4200, "CONFIRMED"))], true);
  assert.equal(summary.confirmed, 4200);
  assert.equal(summary.received, 4200);
  assert.equal(summary.expected, 5000);
});

test("8. an empty class, no rows or missing values all give zero amounts", () => {
  assert.deepEqual(summarizeFeeRows([], true), EMPTY_FEE_SUMMARY);
  assert.deepEqual(summarizeFeeRows(undefined, true), EMPTY_FEE_SUMMARY);
  assert.deepEqual(summarizeFeeRows(null, false), EMPTY_FEE_SUMMARY);
  // A row without a payments array, and non-numeric amounts, are treated safely.
  const odd = [
    { finalAmount: 3000, payments: undefined },
    { finalAmount: Number.NaN, payments: null },
    { finalAmount: 2000, payments: [{ amount: Number.NaN, status: "PENDING" as const }] },
  ];
  assert.deepEqual(summarizeFeeRows(odd, true), { expected: 5000, due: 3000, received: 0, confirmed: 0 });
  // The shared zero summary is never mutated.
  assert.deepEqual(EMPTY_FEE_SUMMARY, { expected: 0, due: 0, received: 0, confirmed: 0 });
});

test("9. discounts, late-join deductions and waivers come only from finalAmount", () => {
  // Fee 6000 with a 500 discount, 1000 late-join deduction and 500 waiver
  // has finalAmount 4000 (computed by the server); no adjustment is re-applied.
  const adjusted = { finalAmount: 4000, amount: 6000, discount: 500, lateJoinDeduct: 1000, waiverAmount: 500, payments: [] };
  assert.deepEqual(summarizeFeeRows([adjusted], true), { expected: 4000, due: 4000, received: 0, confirmed: 0 });
});

test("Received is never less than Confirmed", () => {
  const summary = summarizeFeeRows(EXAMPLE, true);
  assert.ok(summary.received >= summary.confirmed);
});

test("10. All classes: amounts add up per class and each class counts once", () => {
  const classA = summarizeFeeRows(EXAMPLE, true);
  const classB = summarizeFeeRows([row(5000, pay(5000, "CONFIRMED")), row(2000)], true);
  assert.deepEqual(addFeeSummaries([classA, classB]), {
    expected: 160000,
    due: 65000,
    received: 95000,
    confirmed: 65000,
  });
  // A class that has not reported yet contributes nothing.
  assert.deepEqual(addFeeSummaries([classA, undefined]), classA);
  assert.deepEqual(addFeeSummaries([]), EMPTY_FEE_SUMMARY);

  // The header keys the summaries by class id, so a class reporting again
  // replaces its earlier amounts instead of adding to them.
  assert.match(SOURCE, /return \{ \.\.\.prev, \[id\]: summary \};/);
  assert.match(SOURCE, /addFeeSummaries\(relevantClassIds\.map\(\(id\) => classSummaries\[id\]\)\)/);
});

test("11. an older response cannot overwrite a newer class/year/month selection", () => {
  const counter = { current: 0 };
  const first = ++counter.current; // e.g. March requested
  const second = ++counter.current; // then April requested
  assert.equal(isLatestSheetRequestId(counter, first), false);
  assert.equal(isLatestSheetRequestId(counter, second), true);

  const april = { class: { id: "c1" }, year: 2026, month: 4 };
  assert.equal(sheetMatchesSelection(april, { classId: "c1", year: 2026, month: 4 }), true);
  assert.equal(sheetMatchesSelection(april, { classId: "c1", year: 2026, month: 3 }), false);
  assert.equal(sheetMatchesSelection(april, { classId: "c1", year: 2025, month: 4 }), false);
  assert.equal(sheetMatchesSelection(april, { classId: "c2", year: 2026, month: 4 }), false);
  assert.equal(sheetMatchesSelection(null, { classId: "c1", year: 2026, month: 4 }), false);

  // loadSheet, reprocess and the fee amount update only write the sheet while
  // they are still the newest request; the summary reads only a matching sheet.
  const guardedWrites = SOURCE.match(/if \(isLatestSheetRequestId\(sheetRequestRef, requestId\)\) setSheet\(payload\.data\);/g) ?? [];
  assert.equal(guardedWrites.length, 3);
  assert.doesNotMatch(SOURCE, /^\s*setSheet\(payload\.data\);/m);
  assert.match(SOURCE, /sheetMatchesSelection\(sheet, \{ classId, year, month \}\) \? sheet : null/);
});

test("12. the sheet reloads on class/year/month changes and after payment actions", () => {
  assert.match(SOURCE, /\}, \[classId, year, month\]\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*void loadSheet\(\);\s*\n\s*\}, \[loadSheet\]\);/);
  assert.equal((SOURCE.match(/onChanged=\{loadSheet\}/g) ?? []).length, 2);
  assert.match(SOURCE, /await onChanged\(\);/);
  // The confirm / clarification request itself is unchanged.
  assert.match(SOURCE, /fetch\(`\/api\/classes\/\$\{classId\}\/payments\/\$\{payment\.id\}\/confirm`/);
});

test("the summary view shows all four amounts in rupees with their meaning", () => {
  const html = text(renderToStaticMarkup(<FeeSummaryAmounts summary={summarizeFeeRows(EXAMPLE, true)} isPastDue />));
  assert.match(html, /Expected total Rs\. 153,000/);
  assert.match(html, /Due amount Rs\. 63,000/);
  assert.match(html, /Received amount Rs\. 90,000/);
  assert.match(html, /Confirmed amount Rs\. 60,000/);
  assert.match(html, /Rs\. 30,000 awaiting confirmation/);
  assert.match(html, /Past due, no slip submitted/);

  const before = text(renderToStaticMarkup(<FeeSummaryAmounts summary={summarizeFeeRows(EXAMPLE, false)} isPastDue={false} />));
  assert.match(before, /Due amount Rs\. 0 Not yet past the due date/);

  const compact = text(renderToStaticMarkup(<FeeSummaryAmounts summary={EMPTY_FEE_SUMMARY} compact />));
  assert.match(compact, /Expected total Rs\. 0 Due amount Rs\. 0 Received amount Rs\. 0 Confirmed amount Rs\. 0/);
});

test("the existing class fee, due date and student count tiles are kept", () => {
  assert.match(SOURCE, /Current class fee/);
  assert.match(SOURCE, /Due date \(week \{currentSheet\.class\.paymentDueWeek\}\)/);
  assert.match(SOURCE, /Students\s*<\/p>\s*<p className="text-sm font-bold text-slate-900">\s*\{currentSheet\.rows\.length\}/);
  assert.match(SOURCE, /<FeeSummaryAmounts summary=\{summary\} isPastDue=\{currentSheet\.isPastDue\} \/>/);
});
