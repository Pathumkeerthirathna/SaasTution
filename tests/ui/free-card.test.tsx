/**
 * Free Cards on the teacher Payments page (components/class-fee-sheet-panel.tsx)
 * and the student Payments page (components/student-portal/student-payments-client.tsx):
 * selection helpers, the toolbar, the result panel, the badge, the student
 * card and the Expected / Due / Received / Confirmed summary with cards.
 * react-dom/server renders; no browser, no server.
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/free-card.test.tsx
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FreeCardBadge,
  FreeCardResultPanel,
  FreeCardToolbar,
  effectiveSelection,
  freeCardConfirmText,
  freeCardOutcomeText,
  selectableFeeIds,
  summarizeFeeRows,
  toggleAllSelection,
  toggleSelection,
} from "../../components/class-fee-sheet-panel";
import { PaymentCard } from "../../components/student-portal/student-payments-client";
import { StudentClasses, groupByClass } from "../../app/student/Components/StudentClasses";

const ROOT = path.join(__dirname, "..", "..");
const PANEL = readFileSync(path.join(ROOT, "components", "class-fee-sheet-panel.tsx"), "utf8");
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};

type Status = "PAID" | "PENDING" | "UNPAID" | "FREE_CARD";
const r = (feeId: string | null, paymentStatus: Status, freeCard = false) => ({ feeId, paymentStatus, freeCard });

const ROWS = [
  r("a", "UNPAID"),
  r("b", "FREE_CARD", true),
  r("c", "PAID"),
  r("d", "PENDING"),
  r(null, "UNPAID"),
];

test("selectable rows: every fee without a confirmed payment (never a paid or missing fee)", () => {
  assert.deepEqual(selectableFeeIds(ROWS), ["a", "b", "d"]);
  assert.deepEqual(selectableFeeIds([]), []);
  assert.deepEqual(selectableFeeIds(undefined), []);
});

test("multiple selection: toggling adds and removes one row at a time", () => {
  let selected = new Set<string>();
  selected = toggleSelection(selected, "a");
  selected = toggleSelection(selected, "d");
  assert.deepEqual([...selected].sort(), ["a", "d"]);
  selected = toggleSelection(selected, "a");
  assert.deepEqual([...selected], ["d"]);
});

test("select-all: all eligible rows, then none; a paid row is never selected", () => {
  const all = toggleAllSelection(new Set(["a"]), ROWS);
  assert.deepEqual([...all].sort(), ["a", "b", "d"]);
  assert.deepEqual([...toggleAllSelection(all, ROWS)], []);
  // A stale selection (a row now paid or gone) is ignored.
  assert.deepEqual(effectiveSelection(new Set(["a", "c", "zz"]), ROWS), ["a"]);
});

test("toolbar: counts, select-all and the two actions enabled only when they apply", () => {
  const html = renderToStaticMarkup(
    <FreeCardToolbar
      selectedCount={2}
      selectableCount={3}
      canIssue
      canRevoke={false}
      busy={false}
      onToggleAll={noop}
      onIssue={noop}
      onRevoke={noop}
    />
  );
  assert.match(text(html), /2 of 3 selected/);
  assert.match(html, /aria-label="Select all eligible students"/);
  assert.match(html, /<button[^>]*>.*?Issue Free Card<\/button>/);
  assert.doesNotMatch(html.match(/<button[^>]*>(?:(?!<\/button>).)*Issue Free Card/)?.[0] ?? "", / disabled=""/);
  assert.match(html.match(/<button[^>]*>(?:(?!<\/button>).)*Revoke Free Card/)?.[0] ?? "", / disabled=""/);

  const none = renderToStaticMarkup(
    <FreeCardToolbar
      selectedCount={0}
      selectableCount={3}
      canIssue={false}
      canRevoke={false}
      busy={false}
      onToggleAll={noop}
      onIssue={noop}
      onRevoke={noop}
    />
  );
  assert.match(text(none), /Select students for Free Cards/);

  const allChecked = renderToStaticMarkup(
    <FreeCardToolbar
      selectedCount={3}
      selectableCount={3}
      canIssue={false}
      canRevoke
      busy={false}
      onToggleAll={noop}
      onIssue={noop}
      onRevoke={noop}
    />
  );
  assert.match(allChecked, /<input type="checkbox"[^>]*checked=""/);
  assert.doesNotMatch(allChecked.match(/<button[^>]*>(?:(?!<\/button>).)*Revoke Free Card/)?.[0] ?? "", / disabled=""/);
});

test("confirmation and outcome texts", () => {
  assert.match(freeCardConfirmText("issue", 3, "Dec 2026"), /^Issue a Free Card to 3 selected students for Dec 2026\? .*Rs\. 0/);
  assert.match(freeCardConfirmText("revoke", 1, "Dec 2026"), /^Revoke the Free Card of 1 selected student for Dec 2026\?/);
  assert.equal(
    freeCardOutcomeText({ action: "issue", processed: [{ feeId: "a", studentName: "A" }], skipped: [] }),
    "1 Free Card issued."
  );
  assert.equal(
    freeCardOutcomeText({
      action: "revoke",
      processed: [
        { feeId: "a", studentName: "A" },
        { feeId: "b", studentName: "B" },
      ],
      skipped: [{ feeId: "c", studentName: "C", reason: "NO_FREE_CARD", message: "Has no Free Card for this month." }],
    }),
    "2 Free Cards revoked · 1 skipped."
  );
});

test("result panel: skipped students with their reasons", () => {
  const html = text(
    renderToStaticMarkup(
      <FreeCardResultPanel
        outcome={{
          action: "issue",
          processed: [{ feeId: "a", studentName: "Nimal" }],
          skipped: [
            { feeId: "d", studentName: "Kavindi", reason: "PENDING_PAYMENT", message: "A payment slip is waiting for your confirmation." },
            { feeId: "x", studentName: null, reason: "NOT_IN_SHEET", message: "Not a fee of this class and month." },
          ],
        }}
        onDismiss={noop}
      />
    )
  );
  assert.match(html, /1 Free Card issued · 2 skipped\./);
  assert.match(html, /Kavindi — A payment slip is waiting for your confirmation\./);
  assert.match(html, /Unknown fee — Not a fee of this class and month\./);
});

test("badge, and both layouts (cards below xl, table above) carry selection, badge and locks", () => {
  assert.match(text(renderToStaticMarkup(<FreeCardBadge />)), /Free card/);

  const count = (pattern: RegExp) => (PANEL.match(pattern) ?? []).length;
  assert.equal(count(/toggleSelection\(current, row\.feeId!\)/g), 2, "a checkbox per row in both layouts");
  assert.equal(count(/aria-label=\{`Select \$\{row\.studentName\}`\}/g), 2);
  assert.equal(count(/row\.paymentStatus === "FREE_CARD" \? \(\s*<FreeCardBadge \/>/g), 2, "badge in both layouts");
  assert.equal(count(/paidLocked \|\|\s*row\.freeCard;/g), 2, "adjustment inputs locked in both layouts");
  assert.equal(count(/freeCard=\{row\.freeCard\}/g), 2, "amount editor locked in both layouts");
  // The refreshed sheet from the bulk response is applied only while newest.
  assert.match(PANEL, /if \(isLatestSheetRequestId\(sheetRequestRef, requestId\)\) setSheet\(nextSheet\);/);
  assert.match(PANEL, /fetch\("\/api\/payments\/fees\/free-cards"/);
  // A new class / year / month clears the selection.
  assert.match(PANEL, /setSelectedFeeIds\(new Set\(\)\);\s*setFreeCardOutcome\(null\);\s*\}, \[classId, year, month\]\);/);
});

test("summary amounts: a Free Card adds zero everywhere and is never Due", () => {
  const rows = [
    { finalAmount: 0, payments: [] }, // Free Card, no slip
    { finalAmount: 2000, payments: [] },
    { finalAmount: 1500, payments: [{ amount: 1500, status: "CONFIRMED" as const }] },
  ];
  assert.deepEqual(summarizeFeeRows(rows, true), { expected: 3500, due: 2000, received: 1500, confirmed: 1500 });
  assert.deepEqual(summarizeFeeRows(rows, false), { expected: 3500, due: 0, received: 1500, confirmed: 1500 });
});

const feeItem = (over: Record<string, unknown> = {}) => ({
  feeId: "f1",
  classId: "c1",
  className: "Maths",
  teacherName: "Teacher",
  year: 2026,
  month: 12,
  dueDate: "2026-12-28T23:59:59.999Z",
  amount: 2000,
  discount: 0,
  lateJoinDeduct: 800,
  waiverAmount: 0,
  finalAmount: 1200,
  state: "UNPAID" as const,
  payment: null,
  ...over,
});

test("student card: a Free Card shows the badge and Rs 0, and never asks for a slip", () => {
  const html = text(
    renderToStaticMarkup(<PaymentCard fee={{ ...feeItem(), state: "FREE_CARD", finalAmount: 0 }} onSubmit={noop} />)
  );
  assert.match(html, /Free card/);
  assert.match(html, /Free Card \(100% waiver\) − Rs 2,000/);
  assert.match(html, /Final amount Rs 0/);
  assert.match(html, /No payment slip is needed/);
  assert.doesNotMatch(html, /Submit payment slip|Re-submit slip/);
  assert.doesNotMatch(html, /Late-join deduction/, "the card replaces the adjustment lines");
});

test("student card: a normal unpaid fee is unchanged", () => {
  const html = text(renderToStaticMarkup(<PaymentCard fee={feeItem()} onSubmit={noop} />));
  assert.match(html, /To pay/);
  assert.match(html, /Late-join deduction − Rs 800/);
  assert.match(html, /Final amount Rs 1,200/);
  assert.match(html, /Submit payment slip/);
  assert.doesNotMatch(html, /Free card/i);
});

// ---- Student classes (teacher / guardian view of a student) ------------------------------

const classInfo = (payments: { id: string; status: "CONFIRMED" | "PENDING"; month: number }[]) => ({
  id: "c1",
  name: "Combined Maths",
  description: "Grade 12",
  schedule: "Sat 9:00",
  monthlyFee: 2000,
  payments: payments.map((p) => ({ id: p.id, amount: 2000, status: p.status, classStudentFee: { year: 2026, month: p.month } })),
  studentHistory: [{ id: "h1", action: "ASSIGNED", actionDate: "2026-10-01T10:00:00.000Z", reason: null }],
});

const enrolment = (
  id: string,
  over: { isActive?: boolean; fees?: { id: string; year: number; month: number }[]; payments?: { id: string; status: "CONFIRMED" | "PENDING"; month: number }[] } = {}
) => ({
  id,
  isActive: over.isActive ?? true,
  assignedAt: "2026-10-01T10:00:00.000Z",
  removedAt: null,
  removeReason: null,
  fees: over.fees,
  class: classInfo(over.payments ?? []),
});

test("student classes: Free Card months are listed as settled beside the payments, newest first", () => {
  const rows = [
    enrolment("e-new", {
      fees: [{ id: "fc-dec", year: 2026, month: 12 }],
      payments: [
        { id: "p-oct", status: "CONFIRMED", month: 10 },
        { id: "p-nov", status: "PENDING", month: 11 },
      ],
    }),
  ];

  const [group] = groupByClass(rows);
  assert.deepEqual(group.freeCards.map((f) => f.id), ["fc-dec"]);
  assert.deepEqual(group.records.map((r) => r.key), ["free-card-fc-dec", "p-nov", "p-oct"]);

  const html = text(renderToStaticMarkup(<StudentClasses studentId="s1" data={rows} />));
  assert.match(html, /1 \/ 2 paid/, "the existing paid count is unchanged");
  assert.match(html, /\+ 1 free card \(settled\)/);
  assert.match(html, /Payment Records 3/);
  assert.match(html, /Dec 2026 Free card · settled/);
  assert.match(html, /Nov 2026 PENDING/);
  assert.match(html, /Oct 2026 CONFIRMED/);
  // Class information is unchanged.
  assert.match(html, /Rs\. 2,000/);
  assert.match(html, /Sat 9:00/);
});

test("student classes: a card on a removed enrolment is shown once; no card means no indicator", () => {
  const rows = [
    enrolment("e-new", { payments: [] }),
    enrolment("e-old", { isActive: false, fees: [{ id: "fc-nov", year: 2026, month: 11 }] }),
  ];
  const [group] = groupByClass(rows);
  assert.deepEqual(group.freeCards.map((f) => f.id), ["fc-nov"]);
  assert.equal(group.records.length, 1);

  const html = text(renderToStaticMarkup(<StudentClasses studentId="s1" data={[enrolment("e1")]} />));
  assert.match(html, /0 \/ 0 paid/);
  assert.match(html, /No payments recorded\./);
  assert.doesNotMatch(html, /free card/i);

  // Older API responses without "fees" still render.
  const legacy = [{ ...enrolment("e2", { payments: [{ id: "p1", status: "CONFIRMED", month: 9 }] }), fees: undefined }];
  assert.equal(groupByClass(legacy)[0].records.length, 1);
});
