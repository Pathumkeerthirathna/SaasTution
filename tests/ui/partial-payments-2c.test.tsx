/**
 * Partial payments, Stage 2C: the teacher's Record payment form, payment
 * history, reversal and the request-key (idempotency) handling on the
 * Payments page. Pure helpers, a fake fetch and static rendering (no DOM).
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/partial-payments-2c.test.tsx
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  canReversePayment,
  canSubmitReversal,
  createRequestKey,
  createSingleFlight,
  describeApiFailure,
  emptyRecordForm,
  FeePaymentPosition,
  RecordAttemptStore,
  recordPaymentBlock,
  RecordPaymentButton,
  RecordPaymentFormView,
  recordPaymentOnce,
  ReversalFormView,
  sriLankaToday,
  submitReversal,
  validateRecordPayment,
  validateReversalReason,
  type RecordableRow,
} from "../../components/fee-payment-actions";
import { PaymentReviewCard } from "../../components/class-fee-sheet-panel";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const ROOT = path.join(__dirname, "..", "..");
const PANEL = readFileSync(path.join(ROOT, "components", "class-fee-sheet-panel.tsx"), "utf8");
const NOW = new Date("2026-12-21T03:30:00.000Z"); // 21 Dec 2026, 09:00 in Sri Lanka

// ---- fake fetch ---------------------------------------------------------------------------

type Call = { url: string; body: Record<string, unknown> };
type Reply = { status: number; json?: unknown } | "network-error" | { status: number; text: string };

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    if ("text" in reply) return new Response(reply.text, { status: reply.status });
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, impl };
}

const ok = (status: number, data: unknown) => ({ status, json: { success: true, data } });
const refused = (status: number, code: string, message = "Refused by the server.") => ({
  status,
  json: { success: false, error: { code, message } },
});
const position = (state: string, confirmedTotal: number, outstanding: number) => ({
  replayed: false,
  feePayment: { state, confirmedTotal, outstanding, overpaidAmount: 0, pendingTotal: 0, clarificationTotal: 0, reversedTotal: 0 },
});

const row = (over: Partial<RecordableRow> = {}): RecordableRow => ({
  feeId: "fee-1",
  studentName: "Nimal",
  freeCard: false,
  paymentStatus: "UNPAID",
  paymentSummary: { confirmedTotal: 0, outstanding: 2500, overpaidAmount: 0 },
  payments: [],
  ...over,
});

const form = (over: Partial<ReturnType<typeof emptyRecordForm>> = {}) => ({ ...emptyRecordForm(2500, NOW), ...over });

function sequentialKeys() {
  let n = 0;
  return () => `request-key-${String(++n).padStart(4, "0")}`;
}

// ---- 1-4: recording and validation --------------------------------------------------------

test("record a full payment: the outstanding balance is the default amount; the request carries the form and a request key", async () => {
  const values = emptyRecordForm(2500, NOW);
  assert.deepEqual(values, { amount: "2500", paymentMethod: "CASH", receivedDate: "2026-12-21", note: "" });
  const { errors, payload } = validateRecordPayment({ ...values, note: "  Paid at class  " }, 2500, NOW);
  assert.deepEqual(errors, {});
  assert.deepEqual(payload, { amount: 2500, paymentMethod: "CASH", receivedAt: "2026-12-21T06:30:00.000Z", note: "Paid at class" });

  const api = fakeFetch([ok(201, position("PAID", 2500, 0))]);
  const attempts = new RecordAttemptStore(sequentialKeys());
  const outcome = await recordPaymentOnce({ classId: "class-1", feeId: "fee-1", payload: payload!, attempts, flight: createSingleFlight(), fetchImpl: api.impl });
  assert.equal(outcome?.kind, "ok");
  assert.equal(api.calls[0].url, "/api/classes/class-1/fees/fee-1/payments");
  assert.deepEqual(api.calls[0].body, { ...payload, requestKey: "request-key-0001" });
  assert.equal(attempts.isOpen("fee-1"), false, "a definite answer ends the operation");
});

test("record a partial payment; the position shows the server's confirmed and outstanding amounts", async () => {
  const { payload } = validateRecordPayment(form({ amount: "1000", paymentMethod: "BANK_TRANSFER" }), 2500, NOW);
  assert.equal(payload?.amount, 1000);
  assert.equal(payload?.paymentMethod, "BANK_TRANSFER");
  assert.equal("note" in payload!, false, "an empty note is not sent");
  const api = fakeFetch([ok(201, position("PARTIAL", 1000, 1500))]);
  const outcome = await recordPaymentOnce({ classId: "c", feeId: "f", payload: payload!, attempts: new RecordAttemptStore(), flight: createSingleFlight(), fetchImpl: api.impl });
  assert.equal(outcome?.kind === "ok" && outcome.data.feePayment.outstanding, 1500);

  const html = text(renderToStaticMarkup(<FeePaymentPosition state="PARTIAL" summary={{ confirmedTotal: 1000, outstanding: 1500, overpaidAmount: 0 }} />));
  assert.match(html, /Partly paid Confirmed Rs\. 1,000 Outstanding Rs\. 1,500/);
  assert.doesNotMatch(html, /Overpaid/);
  const overpaid = text(renderToStaticMarkup(<FeePaymentPosition state="PAID" summary={{ confirmedTotal: 3000, outstanding: 0, overpaidAmount: 500 }} />));
  assert.match(overpaid, /Paid Confirmed Rs\. 3,000 Outstanding Rs\. 0 Overpaid Rs\. 500/);
  for (const [state, label] of [["UNPAID", "Unpaid"], ["PENDING", "Slip awaiting review"], ["FREE_CARD", "Free Card"]] as const) {
    assert.match(text(renderToStaticMarkup(<FeePaymentPosition state={state} />)), new RegExp(label));
  }
});

test("validation: amount must be a positive whole number; method, date and note are checked", () => {
  const amountError = (amount: string) => validateRecordPayment(form({ amount }), 2500, NOW).errors.amount;
  assert.match(amountError("")!, /Enter the amount/);
  assert.match(amountError("0")!, /more than zero/);
  assert.match(amountError("-5")!, /whole number/);
  assert.match(amountError("10.5")!, /whole number/);
  assert.match(amountError("1e3")!, /whole number/);
  assert.match(amountError("abc")!, /whole number/);
  assert.equal(amountError(" 2500 "), undefined);

  assert.match(validateRecordPayment(form({ paymentMethod: "" }), 2500, NOW).errors.paymentMethod!, /Choose how/);
  assert.match(validateRecordPayment(form({ paymentMethod: "CHEQUE" as never }), 2500, NOW).errors.paymentMethod!, /Choose how/);
  assert.match(validateRecordPayment(form({ receivedDate: "" }), 2500, NOW).errors.receivedDate!, /Enter the date/);
  assert.match(validateRecordPayment(form({ receivedDate: "2026-12-22" }), 2500, NOW).errors.receivedDate!, /future/);
  assert.equal(validateRecordPayment(form({ receivedDate: "2026-11-30" }), 2500, NOW).errors.receivedDate, undefined);
  assert.match(validateRecordPayment(form({ note: "x".repeat(501) }), 2500, NOW).errors.note!, /at most 500/);
  assert.equal(validateRecordPayment(form({ note: "x".repeat(500) }), 2500, NOW).payload?.note?.length, 500);
  assert.equal(validateRecordPayment(form({ amount: "0" }), 2500, NOW).payload, null, "nothing is sent while invalid");

  // Sri Lankan date, not the browser's: 20:00 UTC on 21 Dec is already 22 Dec in Colombo.
  assert.equal(sriLankaToday(new Date("2026-12-21T20:00:00.000Z")), "2026-12-22");
});

test("an amount above the outstanding balance is refused before sending, and the server's 409 is explained", () => {
  const { errors, payload } = validateRecordPayment(form({ amount: "2501" }), 2500, NOW);
  assert.equal(payload, null);
  assert.match(errors.amount!, /cannot be more than the outstanding Rs\. 2,500/);
  const message = describeApiFailure({ kind: "rejected", status: 409, code: "AMOUNT_EXCEEDS_OUTSTANDING", message: "x" }, "record");
  assert.match(message, /more than what is still outstanding/);
});

// ---- 5-6: eligibility -----------------------------------------------------------------------

test("Free Card disables recording, with the reason shown", () => {
  const block = recordPaymentBlock(row({ freeCard: true, paymentStatus: "FREE_CARD", paymentSummary: { confirmedTotal: 0, outstanding: 0, overpaidAmount: 0 } }));
  assert.match(block!, /Free Card/);
  const html = renderToStaticMarkup(<RecordPaymentButton block={block} onClick={() => {}} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*Record payment/);
  assert.match(text(html), /Free Card for this month/);
});

test("a pending or clarification slip disables recording; nothing outstanding, no fee and a future month too", () => {
  for (const status of ["PENDING", "NEEDS_CLARIFICATION"] as const) {
    assert.match(recordPaymentBlock(row({ paymentStatus: "PENDING", payments: [{ status }] }))!, /awaiting your review/, status);
  }
  assert.match(recordPaymentBlock(row({ paymentStatus: "PAID", paymentSummary: { confirmedTotal: 2500, outstanding: 0, overpaidAmount: 0 } }))!, /Nothing is outstanding/);
  assert.match(recordPaymentBlock(row({ paymentSummary: undefined }))!, /Nothing is outstanding/);
  assert.match(recordPaymentBlock(row({ feeId: null }))!, /not been created/);
  assert.match(recordPaymentBlock(row(), true)!, /not started/);

  assert.equal(recordPaymentBlock(row()), null, "unpaid");
  assert.equal(recordPaymentBlock(row({ paymentStatus: "PARTIAL", payments: [{ status: "CONFIRMED" }], paymentSummary: { confirmedTotal: 1000, outstanding: 1500, overpaidAmount: 0 } })), null, "partly paid");
  const enabled = renderToStaticMarkup(<RecordPaymentButton block={null} onClick={() => {}} />);
  assert.doesNotMatch(enabled, /disabled=""/);
});

// ---- 7-9: idempotency ---------------------------------------------------------------------

test("a retry after a network error or an uncertain response reuses the exact request key", async () => {
  const api = fakeFetch(["network-error", { status: 502, text: "<html>Bad gateway</html>" }, refused(500, "INTERNAL_ERROR"), ok(200, { ...position("PAID", 2500, 0), replayed: true })]);
  const attempts = new RecordAttemptStore(createRequestKey);
  const flight = createSingleFlight();
  const payload = validateRecordPayment(form(), 2500, NOW).payload!;
  const submit = () => recordPaymentOnce({ classId: "c", feeId: "fee-1", payload, attempts, flight, fetchImpl: api.impl });

  const first = await submit();
  assert.equal(first?.kind, "uncertain");
  assert.match(describeApiFailure(first as never, "record"), /may or may not have been recorded.*will not be recorded twice/);
  assert.equal(attempts.isOpen("fee-1"), true, "kept for the retry (also after closing the dialog)");
  assert.equal((await submit())?.kind, "uncertain", "HTML 502");
  assert.equal((await submit())?.kind, "uncertain", "500");
  const last = await submit();
  assert.equal(last?.kind === "ok" && last.data.replayed, true);

  const keys = api.calls.map((c) => c.body.requestKey);
  assert.equal(new Set(keys).size, 1, "one key for the whole operation");
  assert.match(String(keys[0]), /^[A-Za-z0-9_-]{8,100}$/, "a key the server accepts");
  assert.equal(attempts.isOpen("fee-1"), false);
});

test("a new payment operation gets a new key: after success, after a definite refusal, and per fee", async () => {
  const api = fakeFetch([ok(201, position("PARTIAL", 500, 2000)), refused(409, "PAYMENT_BUSY"), ok(201, position("PARTIAL", 1000, 1500)), ok(201, position("PARTIAL", 500, 2000))]);
  const attempts = new RecordAttemptStore(sequentialKeys());
  const flight = createSingleFlight();
  const payload = validateRecordPayment(form({ amount: "500" }), 2500, NOW).payload!;
  await recordPaymentOnce({ classId: "c", feeId: "fee-1", payload, attempts, flight, fetchImpl: api.impl });
  const busy = await recordPaymentOnce({ classId: "c", feeId: "fee-1", payload, attempts, flight, fetchImpl: api.impl });
  assert.equal(busy?.kind, "rejected");
  await recordPaymentOnce({ classId: "c", feeId: "fee-1", payload, attempts, flight, fetchImpl: api.impl });
  await recordPaymentOnce({ classId: "c", feeId: "fee-2", payload, attempts, flight, fetchImpl: api.impl });
  assert.deepEqual(api.calls.map((c) => c.body.requestKey), ["request-key-0001", "request-key-0002", "request-key-0003", "request-key-0004"]);

  const store = new RecordAttemptStore(sequentialKeys());
  assert.equal(store.keyFor("a"), store.keyFor("a"), "stable while the operation is open");
  assert.notEqual(createRequestKey(), createRequestKey());
});

test("duplicate clicks while a request is running send it once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const impl = async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify({ success: true, data: position("PAID", 2500, 0) }), { status: 201 });
  };
  const attempts = new RecordAttemptStore(sequentialKeys());
  const flight = createSingleFlight();
  const payload = validateRecordPayment(form(), 2500, NOW).payload!;
  const submit = () => recordPaymentOnce({ classId: "c", feeId: "fee-1", payload, attempts, flight, fetchImpl: impl });

  const first = submit();
  assert.equal(flight.busy, true);
  const second = await submit();
  const third = await submit();
  assert.equal(second, undefined, "ignored while running");
  assert.equal(third, undefined);
  release();
  assert.equal((await first)?.kind, "ok");
  assert.equal(calls, 1);
  assert.equal(flight.busy, false);

  const busyForm = text(renderToStaticMarkup(
    <RecordPaymentFormView outstanding={2500} values={form()} errors={{}} busy message={null} retrying={false} maxDate="2026-12-21" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />
  ));
  assert.match(busyForm, /Recording…/);
  assert.match(
    renderToStaticMarkup(<RecordPaymentFormView outstanding={2500} values={form()} errors={{}} busy message={null} retrying={false} maxDate="2026-12-21" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />),
    /<button type="submit" disabled=""/
  );
});

test("the record form shows the outstanding balance, field errors, failures and the retry state", () => {
  const html = text(renderToStaticMarkup(
    <RecordPaymentFormView
      outstanding={1500}
      values={form({ amount: "1600" })}
      errors={{ amount: "The amount cannot be more than the outstanding Rs. 1,500." }}
      busy={false}
      message="The connection failed before the server answered. The payment may or may not have been recorded."
      retrying
      maxDate="2026-12-21"
      onChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />
  ));
  assert.match(html, /Outstanding balance: Rs\. 1,500/);
  assert.match(html, /cannot be more than the outstanding Rs\. 1,500/);
  assert.match(html, /may or may not have been recorded/);
  assert.match(html, /Retry recording/);
  assert.match(html, /Cash Bank transfer Other/);
  assert.match(html, /0\/500/);
});

// ---- 10-11: history -----------------------------------------------------------------------

const slip = {
  id: "p-slip", amount: 1000, status: "CONFIRMED" as const, note: "Paid via app", teacherFeedback: null, hasSlip: true,
  submittedAt: "2026-12-10T09:00:00.000Z", confirmedAt: "2026-12-11T09:00:00.000Z", source: "STUDENT_SLIP" as const, reversed: false,
  paymentMethod: null, receivedAt: null, recordedByName: null, reversal: null,
};
const recorded = {
  id: "p-rec", amount: 1500, status: "CONFIRMED" as const, note: "Deposit ref 42", teacherFeedback: null, hasSlip: false,
  submittedAt: "2026-12-20T09:00:00.000Z", confirmedAt: "2026-12-20T09:00:00.000Z", source: "TEACHER_RECORDED" as const, reversed: false,
  paymentMethod: "BANK_TRANSFER" as const, receivedAt: "2026-12-19T06:30:00.000Z", recordedByName: "Teacher One", reversal: null,
};
const card = (payment: Parameters<typeof PaymentReviewCard>[0]["payment"], onReverse?: () => void) =>
  text(renderToStaticMarkup(<PaymentReviewCard payment={payment} classId="class-1" onChanged={() => {}} onReverse={onReverse} />));

test("payment history shows both sources with their own details", () => {
  const studentSlip = card(slip, () => {});
  assert.match(studentSlip, /Rs\. 1,000 Student slip Confirmed/);
  assert.match(studentSlip, /Submitted:/);
  assert.match(studentSlip, /Student note: Paid via app/);
  assert.match(studentSlip, /View slip/);
  assert.doesNotMatch(studentSlip, /Reverse payment/, "student slips are never reversed here");

  const teacher = card(recorded, () => {});
  assert.match(teacher, /Rs\. 1,500 Recorded by teacher Confirmed/);
  assert.match(teacher, /Method: Bank transfer/);
  assert.match(teacher, /Received: 19 Dec 2026/);
  assert.match(teacher, /Recorded by: Teacher One/);
  assert.match(teacher, /Note: Deposit ref 42/);
  assert.match(teacher, /Reverse payment/);
  assert.doesNotMatch(teacher, /Confirm payment|Request clarification|No slip attached|Student note/);

  // Nothing invented: a recorded payment without a known recorder shows no recorder line.
  assert.doesNotMatch(card({ ...recorded, recordedByName: null }), /Recorded by:/);
  // Without a reversal handler (e.g. read-only views) no reverse action.
  assert.doesNotMatch(card(recorded), /Reverse payment/);
});

test("a reversed payment stays visible, labelled, with the reversal's amount, reason, actor and date", () => {
  const reversal = { amount: 1500, reason: "Recorded on the wrong student", reversedByRole: "TEACHER" as const, reversedByName: "Teacher One", createdAt: "2026-12-21T04:00:00.000Z" };
  const html = card({ ...recorded, reversed: true, reversal }, () => {});
  assert.match(html, /Rs\. 1,500 Recorded by teacher Reversed/);
  assert.match(html, /Reversed Rs\. 1,500 on 21 Dec 2026, 09:30 by Teacher One/);
  assert.match(html, /Reason: Recorded on the wrong student/);
  assert.match(html, /Kept in the history; no longer counted as received/);
  assert.match(html, /Method: Bank transfer/, "the original record is still shown");
  assert.doesNotMatch(html, /Reverse payment/, "never reversed twice");
  assert.match(renderToStaticMarkup(<PaymentReviewCard payment={{ ...recorded, reversed: true, reversal }} classId="c" onChanged={() => {}} />), /line-through/);

  const byAdmin = card({ ...recorded, reversed: true, reversal: { ...reversal, reversedByRole: "ADMIN", reversedByName: null } });
  assert.match(byAdmin, /by an administrator/);
  // An older sheet response with only the flag still labels it.
  assert.match(card({ ...recorded, reversed: true, reversal: null }), /Reversed/);

  assert.equal(canReversePayment(recorded), true);
  assert.equal(canReversePayment({ ...recorded, reversed: true }), false);
  assert.equal(canReversePayment({ ...recorded, reversal }), false);
  assert.equal(canReversePayment(slip), false);
  assert.equal(canReversePayment({ ...slip, status: "PENDING" }), false);
});

// ---- 12-14: reversal -------------------------------------------------------------------------

test("reversal reason: 3 to 500 characters after trimming", () => {
  assert.match(validateReversalReason("")!, /at least 3/);
  assert.match(validateReversalReason("  ab  ")!, /at least 3/);
  assert.match(validateReversalReason("x".repeat(501))!, /at most 500/);
  assert.equal(validateReversalReason("abc"), null);
  assert.equal(validateReversalReason(`  ${"x".repeat(500)}  `), null);
});

test("reversal needs explicit confirmation; the form explains the balance and the retained record", () => {
  assert.equal(canSubmitReversal("Wrong student", false), false);
  assert.equal(canSubmitReversal("no", true), false);
  assert.equal(canSubmitReversal("Wrong student", true), true);

  const view = (reason: string, acknowledged: boolean) =>
    renderToStaticMarkup(
      <ReversalFormView amount={1500} reason={reason} acknowledged={acknowledged} busy={false} error={null} onReason={() => {}} onAcknowledge={() => {}} onSubmit={() => {}} onCancel={() => {}} />
    );
  assert.match(view("Wrong student", false), /<button type="submit" disabled=""/);
  assert.match(view("ab", true), /<button type="submit" disabled=""/);
  assert.doesNotMatch(view("Wrong student", true), /<button type="submit" disabled=""/);
  const html = text(view("", false));
  assert.match(html, /Reversing adds Rs\. 1,500 back to the student's outstanding balance/);
  assert.match(html, /original payment record is kept in the payment history/);
  assert.match(html, /I confirm this payment of Rs\. 1,500 should be reversed/);
});

test("a successful reversal returns the restored outstanding balance; the page reloads the sheet", async () => {
  const api = fakeFetch([ok(201, { reversal: { id: "r1" }, feePayment: { state: "UNPAID", confirmedTotal: 0, outstanding: 2500, overpaidAmount: 0 } })]);
  const outcome = await submitReversal({ classId: "class-1", paymentId: "p-rec", reason: "  Wrong student  ", fetchImpl: api.impl });
  assert.equal(outcome.kind === "ok" && outcome.data.feePayment.outstanding, 2500);
  assert.equal(api.calls[0].url, "/api/classes/class-1/payments/p-rec/reversal");
  assert.deepEqual(api.calls[0].body, { reason: "Wrong student" });

  // After recording or reversing, the whole sheet reloads: rows, history,
  // per-class totals (onSummaryChange) and the row's status come from the server.
  assert.match(PANEL, /onReversed=\{async \(\) => \{\s*setReversePayment\(null\);\s*toast\.success\([^)]*\);\s*await loadSheet\(\);/);
  assert.match(PANEL, /onRecorded=\{async \(\{ replayed \}\) => \{\s*setRecordFeeId\(null\);\s*toast\.success\([^;]*\);\s*await loadSheet\(\);/);
});

// ---- 15: errors ------------------------------------------------------------------------------

test("API failures become useful messages (400, 404, 409 codes, auth, uncertain)", async () => {
  const rejected = (status: number, code: string | null, message = "") => ({ kind: "rejected" as const, status, code, message });
  assert.match(describeApiFailure(rejected(409, "SUBMISSION_AWAITING"), "record"), /awaiting your review/);
  assert.match(describeApiFailure(rejected(409, "FREE_CARD_ACTIVE"), "record"), /Free Card/);
  assert.match(describeApiFailure(rejected(409, "FEE_ALREADY_SETTLED"), "record"), /Nothing is outstanding/);
  assert.match(describeApiFailure(rejected(409, "REQUEST_KEY_CONFLICT"), "record"), /Check the payment history/);
  assert.match(describeApiFailure(rejected(409, "PAYMENT_BUSY"), "record"), /try again/);
  assert.match(describeApiFailure(rejected(404, "FEE_NOT_FOUND"), "record"), /not found/);
  assert.match(describeApiFailure(rejected(404, "CLASS_NOT_FOUND"), "record"), /no longer manage it/);
  assert.equal(describeApiFailure(rejected(400, "VALIDATION_ERROR", "The received date cannot be in the future."), "record"), "The received date cannot be in the future.");
  assert.match(describeApiFailure(rejected(400, "VALIDATION_ERROR"), "record"), /Check the form/);
  assert.match(describeApiFailure(rejected(401, "UNAUTHORIZED"), "record"), /Sign in again/);
  assert.match(describeApiFailure(rejected(409, "ALREADY_REVERSED"), "reverse"), /already been reversed/);
  assert.match(describeApiFailure(rejected(409, "NOT_TEACHER_RECORDED"), "reverse"), /Only payments recorded by a teacher/);
  assert.match(describeApiFailure(rejected(404, "PAYMENT_NOT_FOUND"), "reverse"), /not allowed to reverse/);
  assert.match(describeApiFailure({ kind: "uncertain", message: "The connection failed." }, "reverse"), /retrying is safe/);

  // The reversal call classifies the responses the same way.
  const api = fakeFetch([refused(409, "ALREADY_REVERSED"), refused(409, "NOT_TEACHER_RECORDED"), "network-error"]);
  const call = () => submitReversal({ classId: "c", paymentId: "p", reason: "Wrong student", fetchImpl: api.impl });
  assert.deepEqual(await call(), { kind: "rejected", status: 409, code: "ALREADY_REVERSED", message: "Refused by the server." });
  assert.equal(((await call()) as { code: string }).code, "NOT_TEACHER_RECORDED");
  assert.equal((await call()).kind, "uncertain");
});

// ---- 16: the rest of the Payments page ------------------------------------------------------

test("existing Payments page behaviour is kept: slip review, both layouts, totals and Free Card selection", () => {
  const pending = card({ ...slip, status: "PENDING", confirmedAt: null }, () => {});
  assert.match(pending, /Pending review/);
  assert.match(pending, /Confirm payment/);
  assert.match(pending, /Request clarification/);
  assert.doesNotMatch(pending, /Reverse payment/);
  assert.match(card({ ...slip, hasSlip: false, status: "NEEDS_CLARIFICATION", teacherFeedback: "Blurry", confirmedAt: null }), /No slip attached.*Your feedback: Blurry|Your feedback: Blurry.*No slip attached/);

  // The expanded row (position, Record payment, history) in both layouts; the
  // history keeps the slip confirmation route.
  assert.equal((PANEL.match(/<FeePaymentSection\s/g) ?? []).length, 2);
  assert.match(PANEL, /fetch\(`\/api\/classes\/\$\{classId\}\/payments\/\$\{payment\.id\}\/confirm`/);
  // Dialogs close when the class / year / month changes.
  assert.match(PANEL, /setRecordFeeId\(null\);\s*setReversePayment\(null\);\s*\}, \[classId, year, month\]\);/);
  // No admin reversal UI in this stage.
  assert.doesNotMatch(PANEL, /\/api\/admin\/payments/);
});
