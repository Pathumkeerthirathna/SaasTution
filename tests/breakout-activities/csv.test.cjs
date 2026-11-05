/*
 * Breakout CSV exports (lib/breakout-activities/csv.mjs): formula-injection
 * protection, quoting, BOM / CRLF, Sri Lanka time and the five datasets.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const load = () => import(pathToFileURL(path.join(root, "lib/breakout-activities/csv.mjs")).href);

test("formula injection: = + - @ tab CR at the start are neutralized", async () => {
  const { escapeCsvCell } = await load();
  assert.equal(escapeCsvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(escapeCsvCell("+1+1"), "\"'+1+1\"");
  assert.equal(escapeCsvCell("-2+3"), "\"'-2+3\"");
  assert.equal(escapeCsvCell("@SUM(A1)"), "\"'@SUM(A1)\"");
  assert.equal(escapeCsvCell("\t=1"), "\"'\t=1\"");
  assert.equal(escapeCsvCell("\r=1"), "\"'\r=1\"");
  assert.equal(escapeCsvCell("a=1"), "\"a=1\"", "only the first character matters");
});

test("quoting: every text cell is quoted, quotes doubled, newlines kept", async () => {
  const { escapeCsvCell } = await load();
  assert.equal(escapeCsvCell("plain"), "\"plain\"");
  assert.equal(escapeCsvCell("a,b"), "\"a,b\"");
  assert.equal(escapeCsvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
  assert.equal(escapeCsvCell("line1\nline2"), "\"line1\nline2\"");
});

test("numbers, booleans, empty values", async () => {
  const { escapeCsvCell } = await load();
  assert.equal(escapeCsvCell(2.67), "2.67");
  assert.equal(escapeCsvCell(-1), "-1", "numbers are never prefixed");
  assert.equal(escapeCsvCell(1 / 3), "0.33");
  assert.equal(escapeCsvCell(10000), "10000");
  assert.equal(escapeCsvCell(Number.NaN), "");
  assert.equal(escapeCsvCell(BigInt(42)), "42");
  assert.equal(escapeCsvCell(true), "Yes");
  assert.equal(escapeCsvCell(false), "No");
  assert.equal(escapeCsvCell(null), "");
  assert.equal(escapeCsvCell(undefined), "");
});

test("file format: BOM, CRLF, header row, row width checked", async () => {
  const { toCsv, CSV_BOM } = await load();
  const csv = toCsv(["A", "B"], [["x", 1], ["y", 2]]);
  assert.ok(csv.startsWith(CSV_BOM));
  assert.equal(csv, "﻿\"A\",\"B\"\r\n\"x\",1\r\n\"y\",2\r\n");
  assert.throws(() => toCsv(["A", "B"], [["only one"]]), RangeError);
});

test("Sinhala and Tamil text round-trips", async () => {
  const { toCsv } = await load();
  const csv = toCsv(["Name"], [["සිංහල"], ["தமிழ்"]]);
  assert.ok(csv.includes("\"සිංහල\""));
  assert.ok(csv.includes("\"தமிழ்\""));
});

test("times are shown in Sri Lanka time (UTC+05:30)", async () => {
  const { formatCsvDateTime } = await load();
  assert.equal(formatCsvDateTime(new Date("2026-11-05T20:00:00.000Z")), "2026-11-06 01:30:00");
  assert.equal(formatCsvDateTime("2026-11-05T08:10:05.999Z"), "2026-11-05 13:40:05");
  assert.equal(formatCsvDateTime(null), "");
  assert.equal(formatCsvDateTime("not a date"), "");
});

test("answers are written as option texts", async () => {
  const { formatAnswerForCsv } = await load();
  const options = [{ id: "a", text: "Kandy" }, { id: "b", text: "Colombo" }, { id: "c", text: "Galle" }];
  const single = { id: "q1", kind: "single", prompt: "?", marks: 1, options, correctOptionId: "b" };
  const multiple = { id: "q2", kind: "multiple", prompt: "?", marks: 1, options, correctOptionIds: ["b"] };
  assert.equal(formatAnswerForCsv(single, { kind: "single", optionId: "b" }), "Colombo");
  assert.equal(formatAnswerForCsv(multiple, { kind: "multiple", optionIds: ["c", "a"] }), "Kandy; Galle", "in option order");
  assert.equal(formatAnswerForCsv({ id: "q3", kind: "true_false", prompt: "?", marks: 1, correct: true }, { kind: "true_false", value: false }), "False");
  assert.equal(formatAnswerForCsv({ id: "q4", kind: "short", prompt: "?", marks: 1, acceptedAnswers: ["x"] }, { kind: "short", text: "=1+1" }), "=1+1", "escaped later by the cell writer");
  assert.equal(formatAnswerForCsv(single, null), "");
  assert.equal(formatAnswerForCsv(single, { kind: "short", text: "x" }), "", "kind mismatch");
});

const submissions = [
  { roomName: "Room 1", assignmentTitle: "Essay", studentName: "Amal", studentId: "s1", version: 1, isLatest: false, submittedAt: "2026-11-05T08:00:00.000Z", fileName: null, answerText: "first" },
  { roomName: "Room 1", assignmentTitle: "Essay", studentName: "Amal", studentId: "s1", version: 2, isLatest: true, submittedAt: "2026-11-05T08:05:00.000Z", fileName: "essay.pdf", answerText: "=cmd|' /C calc'!A0" },
];

test("dataset assignments: latest submission only", async () => {
  const { assignmentsCsv } = await load();
  const lines = assignmentsCsv(submissions).slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("\"Room\",\"Assignment\",\"Student\",\"Student ID\",\"Version\""));
  assert.equal(lines[1], "\"Room 1\",\"Essay\",\"Amal\",\"s1\",2,\"2026-11-05 13:35:00\",Yes,\"essay.pdf\",\"'=cmd|' /C calc'!A0\"");
});

test("dataset assignment-history: every version", async () => {
  const { assignmentHistoryCsv } = await load();
  const lines = assignmentHistoryCsv(submissions).slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes(",1,No,"));
  assert.ok(lines[2].includes(",2,Yes,"));
});

test("datasets drafts, quizzes and quiz-answers", async () => {
  const { draftsCsv, quizzesCsv, quizAnswersCsv } = await load();
  const drafts = draftsCsv([{ roomName: "Main room", assignmentTitle: "Essay", studentName: "Nimal", studentId: "s2", answerText: "@draft", updatedAt: "2026-11-05T08:00:00.000Z" }]);
  assert.ok(drafts.endsWith("\"Main room\",\"Essay\",\"Nimal\",\"s2\",\"2026-11-05 13:30:00\",\"'@draft\"\r\n"));

  const quizzes = quizzesCsv([{ roomName: "Room 2", quizTitle: "Quiz", studentName: "Amal", studentId: "s1", attemptStatus: "AUTO_SUBMITTED", autoScore: "2.67", finalScore: { toString: () => "3.00" }, totalMarks: 4, startedAt: "2026-11-05T08:00:00.000Z", submittedAt: null }]);
  assert.ok(quizzes.endsWith("\"Room 2\",\"Quiz\",\"Amal\",\"s1\",\"AUTO_SUBMITTED\",2.67,3,4,\"2026-11-05 13:30:00\",\"\"\r\n"));

  const question = { id: "q1", kind: "short", prompt: "Capital?", marks: 2, acceptedAnswers: ["Colombo"] };
  const answers = quizAnswersCsv([
    { roomName: "Room 2", quizTitle: "Quiz", studentName: "Amal", studentId: "s1", questionNumber: 1, question, answer: { kind: "short", text: "Colombo city" }, auto: 0, overrideMarks: 1.5, note: "Close" },
    { roomName: "Room 2", quizTitle: "Quiz", studentName: "Amal", studentId: "s1", questionNumber: 2, question, answer: null, auto: null, overrideMarks: null, note: null },
  ]);
  const rows = answers.slice(1).trimEnd().split("\r\n");
  assert.equal(rows[1], "\"Room 2\",\"Quiz\",\"Amal\",\"s1\",1,\"short\",\"Capital?\",\"Colombo city\",0,1.5,1.5,2,\"Close\"");
  assert.equal(rows[2], "\"Room 2\",\"Quiz\",\"Amal\",\"s1\",2,\"short\",\"Capital?\",\"\",0,,0,2,\"\"");
});
