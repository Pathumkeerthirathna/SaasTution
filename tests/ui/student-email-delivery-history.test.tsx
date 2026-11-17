/**
 * Teacher email delivery history (components/student-email-delivery-history.tsx)
 * and its wiring in components/student-guardian-management-panel.tsx.
 *
 *   npm run test:ui
 *
 * There is no DOM here (the project's UI tests render with react-dom/server):
 * each state of the dialog is rendered through the exported view and its
 * markup checked; the container's requests and the panel wiring are checked
 * from source. Clicking through the real page in a browser is a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EmailDeliveryHistoryView,
  activationText,
  retryBlockedText,
  type DeliveryItem,
  type EmailDeliveryHistoryViewProps,
} from "../../components/student-email-delivery-history";

const ROOT = path.join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const base: DeliveryItem = {
  id: "d1",
  emailType: "STUDENT_WELCOME",
  status: "SENT",
  displayStatus: "ACCEPTED",
  student: { id: "s1", name: "Nimal Perera", registrationNumber: "PK-001" },
  recipientEmail: "nimal@mail.com",
  attemptCount: 1,
  maxAttempts: 5,
  lastAttemptAt: "2026-11-16T10:00:00.000Z",
  nextRetryAt: null,
  sentAt: "2026-11-16T10:00:01.000Z",
  lastErrorCode: null,
  lastErrorMessage: null,
  lastOutcomeAmbiguous: false,
  activation: null,
  canRetry: false,
  retryBlockedReason: "NOT_FAILED",
  createdAt: "2026-11-16T09:59:00.000Z",
};

const noop = () => {};
function render(overrides: Partial<EmailDeliveryHistoryViewProps> = {}) {
  return renderToStaticMarkup(
    <EmailDeliveryHistoryView
      title="Student email delivery"
      summary={{ total: 4, queued: 1, processing: 0, sent: 2, failed: 1 }}
      items={[base]}
      status=""
      isLoading={false}
      loadError={null}
      pagination={{ page: 1, totalPages: 1, totalItems: 1, hasNextPage: false, hasPreviousPage: false }}
      retryingId={null}
      onRefresh={noop}
      onClose={noop}
      onStatus={noop}
      onPage={noop}
      onRetry={noop}
      {...overrides}
    />
  );
}

test("dialog: title, accepted-is-not-inbox notice, summary tiles, status filters", () => {
  const html = render();
  assert.match(html, /role="dialog"/);
  assert.match(html, /Student email delivery/);
  assert.match(html, /does not guarantee it reached the inbox/);
  for (const label of ["Queued / retrying", "Sending", "Accepted", "Failed"]) assert.match(html, new RegExp(label));
  for (const label of ["All", "Failed", "Queued / retrying", "Sending", "Accepted"]) assert.match(html, new RegExp(`>${label}<`));
});

test("a record shows every requested field", () => {
  const html = render();
  assert.match(html, /Nimal Perera/);
  assert.match(html, /PK-001/);
  assert.match(html, /nimal@mail\.com/);
  assert.match(html, /Welcome email/);
  assert.match(html, /Accepted by email service/);
  assert.match(html, /1 of 5/);
  for (const label of ["Queued:", "Last attempt:", "Next automatic retry:", "Accepted:"]) assert.match(html, new RegExp(label));
});

test("failed, retryable: sanitized error with code, outcome-unknown note, Retry now button", () => {
  const html = render({
    items: [
      {
        ...base,
        status: "FAILED",
        displayStatus: "FAILED",
        sentAt: null,
        attemptCount: 5,
        lastErrorCode: "SMTP_550",
        lastErrorMessage: "550 5.1.1 [address] User unknown",
        lastOutcomeAmbiguous: true,
        canRetry: true,
        retryBlockedReason: null,
      },
    ],
  });
  assert.match(html, /550 5\.1\.1 \[address\] User unknown \(SMTP_550\)/);
  assert.match(html, /may receive this email more than once \(always with the same password\)/);
  assert.match(html, /Retry now/);
  assert.match(html, /5 of 5/);
});

test("failed, not retryable: no Retry button; the Resend Login Details recovery path is shown", () => {
  const item = { ...base, status: "FAILED" as const, displayStatus: "FAILED" as const, sentAt: null, lastErrorCode: "CREDENTIALS_EXPIRED", lastErrorMessage: "The queued credentials expired.", canRetry: false, retryBlockedReason: "CREDENTIALS_UNUSABLE" };
  const html = render({ items: [item] });
  assert.doesNotMatch(html, /Retry now/);
  assert.match(html, /Use Resend Login Details to send new ones/);
  assert.equal(retryBlockedText(item), "These login details can no longer be sent (expired or replaced). Use Resend Login Details to send new ones.");
});

test("retrying automatically: the next retry time; sending: spinner state; a retry in progress disables the buttons", () => {
  const html = render({
    items: [
      { ...base, id: "r", status: "PENDING", displayStatus: "RETRYING", sentAt: null, nextRetryAt: "2026-11-16T10:01:00.000Z", lastErrorCode: "ECONNREFUSED", lastErrorMessage: "connect refused" },
      { ...base, id: "p", status: "PROCESSING", displayStatus: "PROCESSING", sentAt: null },
      { ...base, id: "f", status: "FAILED", displayStatus: "FAILED", sentAt: null, canRetry: true, retryBlockedReason: null },
    ],
    retryingId: "f",
  });
  assert.match(html, /Retrying automatically/);
  assert.match(html, new RegExp(new Date("2026-11-16T10:01:00.000Z").toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, />Sending</);
  assert.match(html, /Queuing…/);
  assert.match(html, /disabled=""/);
});

test("resend activation states are explained (active / pending / NOT active)", () => {
  const resend = { ...base, emailType: "STUDENT_CREDENTIAL_RESEND" as const };
  assert.match(activationText({ ...resend, activation: { state: "ACTIVE", code: null } })!.text, /previous password no longer works/);
  assert.match(activationText({ ...resend, activation: { state: "PENDING", code: null } })!.text, /activating/);
  assert.match(activationText({ ...resend, activation: { state: "NOT_ACTIVATED", code: "ACCOUNT_CHANGED" } })!.text, /NOT active.*previous password still works/);
  assert.match(activationText({ ...resend, status: "PENDING", activation: { state: "NOT_ACTIVATED", code: null } })!.text, /current password is unchanged/);
  const html = render({ items: [{ ...resend, activation: { state: "NOT_ACTIVATED", code: "ACCOUNT_CHANGED" } }] });
  assert.match(html, /New login details/);
  assert.match(html, /is NOT active/);
});

test("loading, error and empty states; pagination", () => {
  assert.match(render({ items: [], isLoading: true }), /Loading email history/);
  const error = render({ loadError: "Email delivery history could not be loaded." });
  assert.match(error, /could not be loaded/);
  assert.match(error, /Try again/);
  assert.match(render({ items: [] }), /No emails yet/);
  assert.match(render({ items: [], status: "FAILED" }), /No emails with this status yet/);
  const paged = render({ pagination: { page: 2, totalPages: 3, totalItems: 25, hasNextPage: true, hasPreviousPage: true } });
  assert.match(paged, /Page 2 of 3 \(25\)/);
  assert.match(paged, /Previous/);
});

test("nothing secret can be displayed: the view's data type has no password, payload or hash field", () => {
  const source = read("components", "student-email-delivery-history.tsx");
  assert.doesNotMatch(source, /temporaryPassword|encryptedPayload|pendingPasswordHash|Fingerprint/);
});

test("container: loads the teacher's history (filters, no-store), retries via POST, refreshes while active", () => {
  const source = read("components", "student-email-delivery-history.tsx");
  assert.match(source, /fetch\(`\/api\/students\/email-deliveries\?\$\{query\.toString\(\)\}`, \{ cache: "no-store" \}\)/);
  for (const key of ["status", "studentId", "importBatchId", "deliveryId"]) assert.match(source, new RegExp(`query\\.set\\("${key}"`));
  assert.match(source, /\/api\/students\/email-deliveries\/\$\{encodeURIComponent\(item\.id\)\}\/retry`, \{ method: "POST" \}/);
  assert.match(source, /setInterval\(\(\) => void load\(\{ quiet: true \}\), 10_000\)/);
  assert.match(source, /if \(retryingRef\.current\) return;/, "double clicks ignored");
});

test("panel: resend shown regardless of email confirmation; Email Delivery entry points; import batch link", () => {
  const panel = read("components", "student-guardian-management-panel.tsx");
  const fn = panel.slice(panel.indexOf("function canResendRegistrationEmails"), panel.indexOf("}\n", panel.indexOf("function canResendRegistrationEmails")));
  assert.doesNotMatch(fn, /emailConfirmed/);
  assert.match(fn, /student\.status !== 2/);
  assert.match(fn, /StudentConfirmationStatus !== "REJECTED"/);
  assert.match(panel, /setEmailHistoryScope\(\{\}\)/, "header button");
  assert.equal((panel.match(/setEmailHistoryScope\(\{ studentId: student\.id, studentName: student\.name \}\)/g) || []).length, 2, "desktop row + mobile card");
  assert.match(panel, /setEmailHistoryScope\(\{ importBatchId \}\)/, "import toast link");
  assert.match(panel, /<StudentEmailDeliveryHistory scope=\{emailHistoryScope\}/);
  assert.match(panel, /Resend Login Details/);
});
