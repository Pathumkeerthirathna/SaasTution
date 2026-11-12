/**
 * The teacher student list's approval decisions
 * (components/student-confirmation-actions.ts) and their wiring in
 * components/student-guardian-management-panel.tsx (desktop table and mobile
 * card). Rules and texts run directly; the wiring is checked from source.
 * Clicking through the real page remains a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  apiErrorMessage,
  CONFIRM_ALL_PROMPT,
  confirmAllSuccessMessage,
  decisionActionsFor,
  PENDING_ACTION_TEXT,
} from "../../components/student-confirmation-actions";

const ROOT = path.join(__dirname, "..", "..");
const panel = readFileSync(path.join(ROOT, "components", "student-guardian-management-panel.tsx"), "utf8").replace(/\r\n/g, "\n");

const s = (StudentConfirmationStatus: string, status = 0) => ({ StudentConfirmationStatus, status });

test("decision actions: pending keeps Confirm/Decline (mobile: Confirm), approved → Decline, rejected → Confirm again", () => {
  assert.deepEqual(decisionActionsFor(s("PENDING"), "table"), ["confirm", "decline"]);
  assert.deepEqual(decisionActionsFor(s("PENDING"), "card"), ["confirm"]);
  for (const variant of ["table", "card"] as const) {
    assert.deepEqual(decisionActionsFor(s("APPROVED"), variant), ["decline-approved"]);
    assert.deepEqual(decisionActionsFor(s("REJECTED"), variant), ["reapprove"]);
    assert.deepEqual(decisionActionsFor(s("SOMETHING_ELSE"), variant), []);
  }
});

test("deleted students have no decision actions; inactive students keep them", () => {
  for (const variant of ["table", "card"] as const) {
    for (const status of ["PENDING", "APPROVED", "REJECTED"]) {
      assert.deepEqual(decisionActionsFor(s(status, 2), variant), [], `${status} deleted ${variant}`);
    }
  }
  assert.deepEqual(decisionActionsFor(s("APPROVED", 1), "table"), ["decline-approved"]);
  assert.deepEqual(decisionActionsFor(s("REJECTED", 1), "card"), ["reapprove"]);
});

test("popover texts: decline-after-confirmation explains that existing sessions may stay active", () => {
  assert.deepEqual(PENDING_ACTION_TEXT["decline-approved"], {
    message:
      "Decline this confirmed student? They will no longer be able to sign in again or join new live classes. Existing login sessions may remain active until they expire.",
    confirmLabel: "Decline",
    tone: "danger",
  });
  assert.deepEqual(PENDING_ACTION_TEXT.reapprove, {
    message: "Confirm this declined student again? They will be able to sign in and join classes.",
    confirmLabel: "Confirm again",
    tone: "positive",
  });
  // Unchanged.
  assert.deepEqual(PENDING_ACTION_TEXT.delete, { message: "Are you sure you want to delete this student?", confirmLabel: "Delete", tone: "danger" });
  assert.deepEqual(PENDING_ACTION_TEXT.activate, { message: "Are you sure you want to activate this student?", confirmLabel: "Activate", tone: "positive" });
});

test("error messages are read from both response shapes", () => {
  assert.equal(apiErrorMessage({ success: false, error: { message: "This student is already confirmed.", code: "X" } }, "fb"), "This student is already confirmed.");
  assert.equal(apiErrorMessage({ success: false, message: "Old shape." }, "fb"), "Old shape.");
  assert.equal(apiErrorMessage({ success: false, error: { message: "" } }, "fb"), "fb");
  assert.equal(apiErrorMessage(null, "fb"), "fb");
  assert.equal(apiErrorMessage({ error: { message: 42 } }, "fb"), "fb");
});

test("bulk approval: the prompt names active students; the toast uses the server's count", () => {
  assert.equal(CONFIRM_ALL_PROMPT, "Confirm all pending active students? Inactive and deleted students are not included.");
  assert.equal(confirmAllSuccessMessage({ success: true, count: 3 }), "3 student(s) confirmed successfully.");
  assert.equal(confirmAllSuccessMessage({ success: true, count: 0 }), "0 student(s) confirmed successfully.");
  assert.equal(confirmAllSuccessMessage({}), "0 student(s) confirmed successfully.");
});

/* ------------------------------ wiring in the panel ------------------------------ */

const between = (from: string, to: string) => {
  const start = panel.indexOf(from);
  assert.notEqual(start, -1, from);
  const end = panel.indexOf(to, start);
  assert.notEqual(end, -1, to);
  return panel.slice(start, end);
};

test("desktop table: pending Confirm/Decline, Confirmed + Decline popover, Declined + Confirm again popover", () => {
  const cell = between('{decisionActionsFor(student, "table").includes("confirm") ? (', "{/* Status: Active / Inactive / Deleted */}");
  assert.match(cell, /onClick=\{\(\) => handleConfirmStudent\(student\)\}/);
  assert.match(cell, /onClick=\{\(\) => handleDeclineStudent\(student\)\}/);
  assert.match(cell, /decisionActionsFor\(student, "table"\)\.includes\("decline-approved"\) && \(\s*<button[\s\S]*?askDeclineConfirmedStudent\(event, student\.id\)[\s\S]*?Decline/);
  assert.match(cell, /decisionActionsFor\(student, "table"\)\.includes\("reapprove"\) && \(\s*<button[\s\S]*?askReapproveStudent\(event, student\.id\)[\s\S]*?Confirm again/);
  assert.match(cell, /Confirmed/);
  assert.match(cell, /Declined/);
});

test("mobile card: REJECTED is shown as Declined (never Verified), with Confirm again; APPROVED is Verified with Decline", () => {
  const card = between('{decisionActionsFor(student, "card").includes("confirm") ? (', "{/* Action Buttons */}");
  const rejected = card.slice(card.indexOf('student.StudentConfirmationStatus === "REJECTED" ? ('));
  assert.ok(card.includes('student.StudentConfirmationStatus === "REJECTED" ? ('), "REJECTED has its own branch");
  const rejectedBranch = rejected.slice(0, rejected.indexOf(") : ("));
  assert.match(rejectedBranch, /Declined/);
  assert.doesNotMatch(rejectedBranch, /Verified/);
  assert.match(rejectedBranch, /askReapproveStudent\(event, student\.id\)[\s\S]*?Confirm again/);
  const approvedBranch = rejected.slice(rejected.indexOf(") : ("));
  assert.match(approvedBranch, /Verified[\s\S]*?askDeclineConfirmedStudent\(event, student\.id\)[\s\S]*?Decline/);
});

test("popovers: decline-approved and reapprove use ConfirmActionPopover and call the decision handler", () => {
  assert.match(panel, /type: PendingStudentAction;/);
  assert.match(panel, /type: "decline-approved",\s*studentId,\s*rect: event\.currentTarget\.getBoundingClientRect\(\),/);
  assert.match(panel, /type: "reapprove",\s*studentId,\s*rect: event\.currentTarget\.getBoundingClientRect\(\),/);
  const popover = between("<ConfirmActionPopover", "/>");
  assert.match(popover, /message=\{PENDING_ACTION_TEXT\[pendingAction\.type\]\.message\}/);
  assert.match(popover, /confirmLabel=\{PENDING_ACTION_TEXT\[pendingAction\.type\]\.confirmLabel\}/);
  assert.match(popover, /tone=\{PENDING_ACTION_TEXT\[pendingAction\.type\]\.tone\}/);
  assert.match(popover, /void decideStudent\(target, type === "reapprove" \? "confirm" : "decline"\)/);
});

test("decision handler: success toast for decline, both error shapes, reload on 409", () => {
  const handler = between("const decideStudent = async", "const handleConfirmAllStudents");
  assert.match(handler, /toast\.error\(apiErrorMessage\(result, fallback\)\)/);
  assert.match(handler, /if \(response\.status === 409\) \{\s*await loadStudentList\(page, filters\);/);
  assert.match(handler, /toast\.success\(isConfirm \? "Student confirmed successfully\." : "Student declined successfully\."\)/);
  assert.doesNotMatch(handler, /toast\.error\("Student declined/);
});

test("bulk handler: active-students prompt, server count, loading state reset in finally", () => {
  const handler = between("const handleConfirmAllStudents = async", "\n};\n");
  assert.match(handler, /if \(!confirm\(CONFIRM_ALL_PROMPT\)\)/);
  assert.match(handler, /toast\.success\(confirmAllSuccessMessage\(result\)\)/);
  assert.doesNotMatch(handler, /pendingCount/);
  assert.match(handler, /\} finally \{\s*setIsConfirmingAll\(false\);\s*\}/);
});
