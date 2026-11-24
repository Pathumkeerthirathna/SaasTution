/**
 * The student's Notes page (Notes redesign Stage 3): app/student/notes,
 * components/student-portal/notes/student-notes-client.tsx and its helpers,
 * plus the sidebar entry. No DOM library in this project: react-dom/server
 * renders of the first paint, the pure helpers, and source checks of the
 * request / stale-response logic. The APIs' own authorization, ordering and
 * lock behaviour: tests/notes/class-notes.test.cjs. Clicking through the real
 * page in a browser remains a manual check.
 *
 *   npm run test:ui   (also npm run test:notes-ui)
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { StudentNotesClient } from "../../components/student-portal/notes/student-notes-client";
import {
  downloadName,
  fileTypeLabel,
  formatNoteSize,
  noteRequestErrorMessage,
  safeNoteFileUrl,
  studentLectureLabel,
  studentLecturesUrl,
  studentNotesUrl,
  uploadedLabel,
} from "../../components/student-portal/notes/student-notes-helpers";
import { studentNavItems } from "../../components/student-portal/student-data";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const CLIENT = () => code(source("components", "student-portal", "notes", "student-notes-client.tsx"));

const C1 = { id: "11111111-1111-4111-8111-111111111111", name: "Physics" };
const C2 = { id: "22222222-2222-4222-8222-222222222222", name: "Chemistry" };
const L = "aaaaaaaa-0000-4000-8000-000000000001";
const N = "bbbbbbbb-0000-4000-8000-000000000001";
const open = { locked: false, year: 2026, month: 11 };
const lockedNov = { locked: true, year: 2026, month: 11 };

// ---- Class selection -------------------------------------------------------------------------------

test("class selection: no active class -> one clear empty state, nothing else", () => {
  const html = renderToStaticMarkup(<StudentNotesClient classes={[]} />);
  assert.match(html, /data-notes-empty="classes"/);
  assert.match(text(html), /You are not enrolled in an active class yet\./);
  assert.doesNotMatch(html, /data-notes-class-select|data-notes-section/);
});

test("class selection: several classes -> the selector and a prompt; no notes are shown or requested before a class is chosen", () => {
  const html = renderToStaticMarkup(<StudentNotesClient classes={[C1, C2]} />);
  assert.match(html, /<select[^>]*data-notes-class-select/);
  assert.match(text(html), /Select a class Physics Chemistry/);
  assert.match(html, /data-notes-empty="no-class"/);
  assert.doesNotMatch(html, /data-notes-section|data-notes-view-tabs/);
  assert.match(CLIENT(), /const notesUrl = classId && \(view === "general" \|\| lectureId\) \? studentNotesUrl\(classId, view === "lecture" \? lectureId : null\) : null;/);
});

test("class selection: a single class is chosen at once and General Notes is the default view (loading)", () => {
  const html = renderToStaticMarkup(<StudentNotesClient classes={[C1]} />);
  assert.match(html, /<option value="11111111-1111-4111-8111-111111111111" selected="">Physics<\/option>/);
  assert.match(html, /data-notes-section="general"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>.*?General Notes/);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>.*?Lecture Notes/);
  assert.match(html, /aria-label="Loading notes"/);
});

test("the page reads the classes on the server: the signed-in student's active enrolments in active classes only", () => {
  const page = code(source("app", "student", "notes", "page.tsx"));
  assert.match(page, /const session = await requireStudentSession\(\);/);
  assert.match(page, /where: \{ studentId: session\.studentId, isActive: true, class: \{ status: 0 \} \}/);
  // ?classId= (the dashboard's links) only pre-selects one of THESE classes; nothing else from the URL.
  assert.match(page, /const requested = typeof searchParams\?\.classId === "string" \? searchParams\.classId : null;/);
  assert.match(page, /const initialClassId = classes\.some\(\(c\) => c\.id === requested\) \? requested : null;/);
  assert.match(page, /<StudentNotesClient classes=\{classes\} initialClassId=\{initialClassId\} \/>/);
  const reads = [...page.matchAll(/searchParams\??\.(\w+)/g)].map((m) => m[1]);
  assert.ok(reads.length > 0 && reads.every((name) => name === "classId"), `only classId is read: ${reads.join(", ")}`);
});

// ---- General / lecture notes ----------------------------------------------------------------------

test("requests: General Notes without a lecture, lecture notes with it (the Stage 1 API); lectures from the existing student API", () => {
  assert.equal(studentNotesUrl(C1.id), `/api/student/classes/${C1.id}/notes`);
  assert.equal(studentNotesUrl(C1.id, null), `/api/student/classes/${C1.id}/notes`);
  assert.equal(studentNotesUrl(C1.id, L), `/api/student/classes/${C1.id}/notes?lectureId=${L}`);
  assert.equal(studentNotesUrl("a/b", "x&y"), "/api/student/classes/a%2Fb/notes?lectureId=x%26y");
  assert.equal(studentLecturesUrl(C1.id, 2), `/api/student/lectures?classId=${C1.id}&scheduled=1&page=2&limit=20`);
  const client = CLIENT();
  assert.match(client, /\.filter\(\(item\) => item\.kind === "lecture"\)/, "schedule placeholders are never offered");
  assert.doesNotMatch(client, /isDefault|defaultLecture/i, "the default lecture is never listed or chosen on the client");
  assert.match(client, /Load older lectures/);
});

test("switching: a new class starts on General Notes with no lecture; General Notes clears the lecture", () => {
  const client = CLIENT();
  assert.match(client, /function chooseClass\(next: string\) \{\s*setClassId\(next\);\s*setView\("general"\);[^\n]*\s*setLectureId\(""\);\s*setLectures\(null\);\s*setLecturePage\(1\);/);
  assert.match(client, /function chooseView\(next: View\) \{\s*setView\(next\);\s*if \(next === "general"\) setLectureId\(""\);/);
});

test("stale responses: every request is aborted on a new selection and its result dropped; a new selection clears the list and the preview at once", () => {
  const client = CLIENT();
  const notesEffect = client.slice(client.indexOf("const shownNotesUrl"), client.indexOf("const previewNoteId"));
  assert.match(notesEffect, /const selectionChanged = shownNotesUrl\.current !== notesUrl;/);
  assert.match(notesEffect, /if \(selectionChanged\) \{\s*closePreview\(\);\s*setFileMessage\(null\);\s*\}/);
  assert.match(notesEffect, /if \(selectionChanged\) setNotes\(\{ state: "loading" \}\);/);
  assert.match(notesEffect, /fetch\(notesUrl, \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(notesEffect, /if \(controller\.signal\.aborted\) return;/);
  assert.match(notesEffect, /return \(\) => controller\.abort\(\);\s*\}, \[notesUrl, notesAttempt, closePreview\]\);/);
  const lecturesEffect = client.slice(client.indexOf("studentLecturesUrl(classId, lecturePage)") - 300);
  assert.match(lecturesEffect, /signal: controller\.signal/);
  // The preview of a note that disappeared or became locked in a refreshed list is closed.
  assert.match(client, /if \(!current \|\| !safeNoteFileUrl\(current\)\) closePreview\(\);/);
  // A file request of an earlier preview never replaces the current one.
  assert.match(client, /const seq = \+\+previewSeq\.current;/);
  assert.match(client, /if \(seq !== previewSeq\.current\) return;/);
  assert.match(client, /previewSeq\.current \+= 1;/);
  assert.match(client, /URL\.revokeObjectURL\(objectUrl\.current\)/, "object URLs are released");
});

// ---- Locked and available notes; files -------------------------------------------------------------

test("file URLs: only the API's fileUrl of the existing student file route, never for a locked note, never anything else", () => {
  const fileUrl = `/api/student/lectures/${L}/notes/${N}/file`;
  assert.equal(safeNoteFileUrl({ fileUrl, resourceAccess: open }), fileUrl);
  assert.equal(safeNoteFileUrl({ fileUrl, resourceAccess: lockedNov }), null, "locked: no action even if a URL were sent");
  assert.equal(safeNoteFileUrl({ fileUrl: null, resourceAccess: open }), null);
  for (const bad of [
    "https://evil.example/api/student/lectures/x/notes/y/file",
    "//evil.example/file",
    `/api/lectures/notes/${N}/download`,
    `/api/student/lectures/${L}/notes/${N}/file?x=1`,
    `/api/student/lectures/../../admin/notes/${N}/file`,
    "javascript:alert(1)",
  ]) {
    assert.equal(safeNoteFileUrl({ fileUrl: bad, resourceAccess: open }), null, bad);
  }
  const client = CLIENT();
  assert.equal((client.match(/safeNoteFileUrl\(note\)/g) ?? []).length, 3, "the card, the preview and the download all go through it");
  assert.doesNotMatch(client, /\/api\/student\/lectures\/\$\{/, "no file URL is built on the client");
});

test("locked notes show the existing lock badge and no preview / download; available notes show both", () => {
  const client = CLIENT();
  const card = client.slice(client.indexOf("{list.map((note) => {"), client.indexOf("{preview ? ("));
  assert.match(card, /\{locked \? \(\s*<div className="mt-2">\s*<LockedResourceBadge lock=\{note\.resourceAccess\} classId=\{classId\} \/>/);
  assert.match(card, /\) : fileUrl \? \(/);
  assert.match(card, /onClick=\{\(\) => void openPreview\(note\)\}/);
  assert.match(card, /onClick=\{\(\) => void download\(note\)\}/);
  assert.match(card, /data-note-state=\{locked \? "locked" : "available"\}/);
  assert.doesNotMatch(card, /href=/, "no direct file link on the card");
});

test("preview and download: fetched first (session, 403, 404 handled), then shown / saved from a blob; the route still records the view", () => {
  const client = CLIENT();
  const preview = client.slice(client.indexOf("async function openPreview"), client.indexOf("async function download"));
  assert.match(preview, /const response = await fetch\(url, \{ cache: "no-store" \}\);/);
  assert.match(preview, /noteRequestErrorMessage\(response\.status, payload\?\.error\?\.message, "file"\)/);
  assert.match(preview, /objectUrl\.current = URL\.createObjectURL\(blob\);/);
  const download = client.slice(client.indexOf("async function download"), client.indexOf("if (classes.length === 0)"));
  assert.match(download, /setFileMessage\(noteRequestErrorMessage\(response\.status, payload\?\.error\?\.message, "file"\)\);/);
  assert.match(download, /link\.download = downloadName\(note\.title, note\.mimeType\);/);
  assert.match(client, /<iframe key=\{preview\.url\} src=\{preview\.url\}/, "the existing iframe preview, for every file type as before");

  assert.equal(noteRequestErrorMessage(401, "x", "file"), "Your session has expired. Please sign in again.");
  assert.equal(noteRequestErrorMessage(403, "Locked: payment required for November 2026.", "file"), "Locked: payment required for November 2026.");
  assert.equal(noteRequestErrorMessage(403, null, "file"), "This note is locked until the payment for its month is made.");
  assert.equal(noteRequestErrorMessage(404, null, "file"), "This note is no longer available.");
  assert.equal(noteRequestErrorMessage(500, null, "file"), "Could not open the file. Please try again.");
  assert.equal(noteRequestErrorMessage(0, null, "file"), "Could not open the file. Please try again.");
  assert.equal(downloadName("Week 1: notes", "application/pdf"), "Week 1- notes.pdf");
  assert.equal(downloadName("scan.png", "image/png"), "scan.png");
});

// ---- Empty / loading / error states; labels --------------------------------------------------------

test("empty, loading and error states: every one has its message; errors offer Try again", () => {
  const client = CLIENT();
  for (const phrase of [
    "Select a class to see its notes.",
    "No general notes for this class yet.",
    "No notes for this lecture yet.",
    "Select a lecture to see its notes.",
    "This class has no lectures yet.",
    "No lectures in this class yet",
    "Loading lectures…",
    "Opening the file…",
  ]) {
    assert.ok(client.includes(phrase), phrase);
  }
  assert.equal((client.match(/Try again/g) ?? []).length, 2, "the notes list and the lecture list");
  assert.equal(noteRequestErrorMessage(401, null, "notes"), "Your session has expired. Please sign in again.");
  assert.equal(noteRequestErrorMessage(409, "This class has no General Notes lecture yet.", "notes"), "This class has no General Notes lecture yet.");
  assert.equal(noteRequestErrorMessage(404, "Lecture not found in this class.", "notes"), "Lecture not found in this class.");
  assert.equal(noteRequestErrorMessage(500, null, "notes"), "Could not load the notes. Please try again.");
  assert.equal(noteRequestErrorMessage(500, null, "lectures"), "Could not load the lectures of this class. Please try again.");
});

test("labels: upload date in Asia/Colombo (or the legacy wording), file type, size, lecture option", () => {
  assert.equal(uploadedLabel("2026-11-24T08:35:00.000Z"), "Uploaded 24 Nov 2026, 14:05");
  assert.equal(uploadedLabel("2026-11-30T19:00:00.000Z"), "Uploaded 1 Dec 2026, 00:30", "after Sri Lankan midnight");
  assert.equal(uploadedLabel(null), "Upload date not recorded");
  assert.deepEqual(
    ["application/pdf", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "text/plain", "application/x-unknown"].map(fileTypeLabel),
    ["PDF", "Image", "Word", "Excel", "Text", "File"]
  );
  assert.equal(formatNoteSize(500), "1 KB");
  assert.equal(formatNoteSize(2.5 * 1024 * 1024), "2.5 MB");
  assert.equal(studentLectureLabel({ id: L, title: "Kinematics", date: "2026-11-23T20:00:00.000Z" }), "Kinematics · 24 Nov 2026");
});

// ---- Responsive, distinct sections, navigation -----------------------------------------------------

test("responsive and distinct: stacked on phones, a row from sm; General (emerald) and Lecture (brand) sections differ; nothing truncated", () => {
  const client = CLIENT();
  assert.match(client, /flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end/);
  assert.match(client, /generalView \? "border-emerald-200 bg-emerald-50\/40" : "border-brand-200 bg-brand-50\/30"/);
  assert.match(client, /h-\[60vh\] w-full rounded-xl border border-slate-200 bg-white sm:h-\[480px\]/);
  assert.doesNotMatch(client, /\btruncate\b|line-clamp|text-ellipsis|\bhidden sm:|\bhidden md:|\bhidden lg:/);
});

test("navigation: Notes right after My Classes (student portal navigation reorganization), with its own icon; the existing student note surfaces are unchanged", () => {
  const hrefs = studentNavItems.map((item) => item.href);
  assert.equal(hrefs.indexOf("/student/notes"), hrefs.indexOf("/student/classes") + 1);
  assert.deepEqual(studentNavItems.find((item) => item.href === "/student/notes"), { href: "/student/notes", label: "Notes", icon: "notes" });
  assert.match(source("components", "student-portal", "student-sidebar.tsx"), /notes:\s+NotebookPen,/);
  // Still the lecture-scoped routes, untouched by this stage.
  assert.match(source("components", "Jitsi", "classroom", "student", "StudentNotesPanel.tsx"), /\/api\/student\/lectures\/\$\{lectureId\}\/notes\/\$\{note\.id\}\/file/);
  assert.match(source("components", "student-portal", "dashboard-study-notes.tsx"), /\/api\/student\/lectures\/\$\{note\.lectureId\}\/notes\/\$\{note\.id\}\/file/);
  assert.match(source("components", "student-portal", "lecture-list-client.tsx"), /\/api\/student\/lectures\/\$\{panelLectureId\}\/notes\/\$\{previewNoteId\}\/file/);
});
