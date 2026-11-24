/**
 * The teacher's Notes page (Notes redesign Stage 2): app/dashboard/notes,
 * components/notes/teacher-notes-workspace.tsx and the class-scoped mode of
 * components/lecture-note-panel.tsx, plus the sidebar entry. No DOM library:
 * react-dom/server renders, the pure helpers and source checks (the panel's
 * requests and the Stage 1 APIs' own behaviour are covered by
 * tests/notes/class-notes.test.cjs). Clicking through the real page in a
 * browser remains a manual check.
 *
 *   npm run test:ui   (also npm run test:notes-ui)
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { LectureNotePanel, formatUploadedAt, noteEndpoints } from "../../components/lecture-note-panel";
import { NOTES_CLASSES_URL, TeacherNotesWorkspace, notesLectureLabel, notesLecturesUrl } from "../../components/notes/teacher-notes-workspace";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const PANEL = () => code(source("components", "lecture-note-panel.tsx"));
const WORKSPACE = () => code(source("components", "notes", "teacher-notes-workspace.tsx"));

// ---- The panel's sources --------------------------------------------------------------------------

test("panel endpoints: the lecture mode is exactly the existing API; General Notes and class lecture notes use the Stage 1 class API", () => {
  assert.deepEqual(noteEndpoints({ lectureId: "L1" }), { list: "/api/lectures/L1/notes", upload: "/api/lectures/L1/notes", classScoped: false });
  assert.deepEqual(noteEndpoints({ classId: "C1" }), { list: "/api/classes/C1/notes", upload: "/api/classes/C1/notes", classScoped: true });
  assert.deepEqual(noteEndpoints({ classId: "C1", lectureId: "L1" }), {
    list: "/api/classes/C1/notes?lectureId=L1",
    upload: "/api/lectures/L1/notes",
    classScoped: true,
  });
  assert.equal(noteEndpoints({ classId: "a/b", lectureId: "x&y" }).list, "/api/classes/a%2Fb/notes?lectureId=x%26y", "ids are encoded");
});

test("panel: lists from the source's endpoint (array or { notes }); uploads to it; edits and deletions use each note's own lecture", () => {
  const panel = PANEL();
  assert.match(panel, /fetch\(endpoints\.list, \{/);
  assert.match(panel, /Array\.isArray\(payload\.data\) \? payload\.data : payload\.data\?\.notes/);
  assert.match(panel, /fetch\(endpoints\.upload, \{\s*method: "POST",\s*body: formData,/);
  assert.match(panel, /fetch\(`\/api\/lectures\/\$\{lectureIdOf\(selectedNote\)\}\/notes\/\$\{selectedNoteId\}`, \{\s*method: "PUT"/);
  assert.match(panel, /fetch\(`\/api\/lectures\/\$\{lectureIdOf\(selectedNote\)\}\/notes\/\$\{selectedNote\.id\}`, \{\s*method: "DELETE"/);
  assert.match(panel, /return note\?\.lectureId \?\? props\.lectureId \?\? "";/);
  assert.doesNotMatch(panel, /\/api\/lectures\/\$\{props\.lectureId\}/, "no request is built from the panel's lecture prop alone any more");
  // The existing preview / download routes and permanent-deletion feedback are unchanged.
  assert.match(panel, /`\/api\/lectures\/notes\/\$\{previewNote\.id\}\/preview`/);
  assert.match(panel, /href=\{`\/api\/lectures\/notes\/\$\{note\.id\}\/download`\}/);
  assert.match(panel, /readDeletionOutcome\(response\.status, payload, NOTE_DELETION_LABELS\)/);
});

test("panel: one save at a time (a ref guard before the disabled button re-renders); stale list responses are dropped", () => {
  const panel = PANEL();
  const save = panel.slice(panel.indexOf("async function saveNote()"), panel.indexOf("async function deleteSelected()"));
  assert.match(save, /if \(savingRef\.current\) \{\s*return;\s*\}/);
  assert.match(save, /savingRef\.current = true;/);
  assert.match(save, /finally \{\s*savingRef\.current = false;\s*setIsSaving\(false\);/);
  assert.match(panel, /disabled=\{isSaving\}\s+className="inline-flex h-9 items-center gap-1\.5 rounded-lg bg-brand-700/, "the upload button");
  assert.match(panel, /const seq = \+\+loadSeqRef\.current;/);
  assert.match(panel, /if \(seq !== loadSeqRef\.current\) return;/);
  assert.match(panel, /\}, \[endpoints\.list\]\);/, "reloads when the class / lecture changes");
});

test("panel: the existing lecture-mode render is unchanged (heading, wording, no upload date line)", () => {
  const html = renderToStaticMarkup(<LectureNotePanel lectureId="L1" />);
  assert.match(text(html), /Existing notes Browse lecture uploads and manage downloads\./);
  assert.match(html, /Add new note/);
  for (const user of ["components/lecture-management-panel.tsx", "components/Jitsi/classroom/sidebar/RightSidebar.tsx"]) {
    assert.match(source(...user.split("/")), /<LectureNotePanel\b[^>]*\blectureId=/, user);
    assert.doesNotMatch(source(...user.split("/")), /<LectureNotePanel\b[^>]*\bclassId=/, `${user}: still the lecture API`);
  }
});

test("panel: class mode shows the heading given and the upload date in Sri Lankan time", () => {
  const html = renderToStaticMarkup(<LectureNotePanel classId="C1" heading="General notes" description="Notes for the whole class." />);
  assert.match(text(html), /General notes Notes for the whole class\./);
  assert.equal(formatUploadedAt("2026-11-24T08:35:00.000Z"), "24 Nov 2026, 14:05");
  assert.equal(formatUploadedAt(null), null);
  assert.equal(formatUploadedAt("not a date"), null);
  assert.match(PANEL(), /\{endpoints\.classScoped \? \(\s*<p className="mt-1 block text-\[10px\] text-slate-500">\s*\{formatUploadedAt\(note\.uploadedAt\) \? `Uploaded \$\{formatUploadedAt\(note\.uploadedAt\)\}` : "Upload date not recorded"\}/);
});

// ---- The workspace ---------------------------------------------------------------------------------

test("workspace: first render: the heading and the class selector only; no notes before a class is chosen", () => {
  const html = renderToStaticMarkup(<TeacherNotesWorkspace />);
  assert.match(html, /<h1 id="notes-page-heading"[^>]*>Notes<\/h1>/);
  assert.match(html, /data-notes-class-select/);
  assert.match(text(html), /Loading classes…/);
  assert.doesNotMatch(html, /data-notes-section=/, "no General / Lecture Notes before a class");
  assert.doesNotMatch(html, /Add new note|Existing notes/, "no notes panel");
});

test("workspace: classes from the existing classes API; lectures from the lecture API (normal lectures only), newest first, paged", () => {
  assert.equal(NOTES_CLASSES_URL, "/api/classes?page=1&pageSize=100");
  assert.equal(notesLecturesUrl("C1", 2), "/api/lectures?classId=C1&page=2&pageSize=100&sortOrder=desc");
  const ws = WORKSPACE();
  assert.match(ws, /getJson<NotesClassOption\[\]>\(NOTES_CLASSES_URL,/);
  assert.match(ws, /getJson<NotesLectureOption\[\]>\(notesLecturesUrl\(classId, lecturePage\),/);
  assert.doesNotMatch(ws, /isDefault|defaultLecture/i, "the default lecture is never listed or chosen on the client (the API excludes it)");
  assert.match(ws, /Load older lectures/);
});

test("workspace: General Notes appear as soon as a class is chosen; Lecture Notes need a lecture; each panel is keyed by its source", () => {
  const ws = WORKSPACE();
  const general = ws.slice(ws.indexOf('data-notes-section="general"'), ws.indexOf('data-notes-section="lecture"'));
  assert.match(general, /<LectureNotePanel\s+key=\{`general:\$\{classId\}`\}\s+classId=\{classId\}\s+heading="General notes"/);
  assert.doesNotMatch(general, /lectureId=/, "General Notes never take a lecture");
  const lecture = ws.slice(ws.indexOf('data-notes-section="lecture"'));
  assert.match(lecture, /\{lectureId \? \(\s*<LectureNotePanel\s+key=\{`lecture:\$\{classId\}:\$\{lectureId\}`\}\s+classId=\{classId\}\s+lectureId=\{lectureId\}/);
  assert.match(lecture, /Select a lecture to see its notes\./);
  assert.match(ws, /const chooseClass = useCallback\(\(next: string\) => \{\s*setClassId\(next\);\s*setLectureId\(""\);\s*setLecturePage\(1\);/, "a new class clears the lecture");
});

test("workspace: loading, empty and error states, with retries", () => {
  const ws = WORKSPACE();
  for (const phrase of [
    "You have no classes yet. Create a class first, then add its notes here.",
    "Select a class to see and manage its notes.",
    "This class has no lectures yet.",
    "No general notes yet. Use Add new note to upload one.",
    "No notes for this lecture yet.",
    "Could not load your classes.",
    "Could not load the lectures of this class.",
  ]) {
    assert.ok(ws.includes(phrase), phrase);
  }
  assert.equal((ws.match(/Try again/g) ?? []).length, 2);
  assert.match(ws, /controller\.abort\(\)/, "requests of a previous class are cancelled");
});

test("workspace: responsive and nothing truncated (sections stack, side by side on extra-large screens; names wrap)", () => {
  const ws = WORKSPACE();
  assert.match(ws, /grid min-w-0 gap-4 xl:grid-cols-2/);
  assert.match(ws, /flex flex-col gap-2 p-3 sm:flex-row sm:items-end sm:px-4/);
  assert.doesNotMatch(ws, /\btruncate\b|line-clamp|text-ellipsis|\bhidden sm:|\bhidden md:|\bhidden lg:/);
});

// ---- The page and navigation -----------------------------------------------------------------------

test("page and sidebar: /dashboard/notes renders the workspace; Notes is in the teacher sidebar right after Attendance", () => {
  const page = source("app", "dashboard", "notes", "page.tsx");
  assert.match(page, /import\("@\/components\/notes\/teacher-notes-workspace"\)\.then\(\(mod\) => mod\.TeacherNotesWorkspace\)/);
  const shell = source("components", "dashboard-shell.tsx");
  const attendance = shell.indexOf('href: "/dashboard/attendance"');
  const notes = shell.indexOf('href: "/dashboard/notes"');
  assert.ok(attendance > 0 && notes > attendance, "after Attendance");
  assert.ok(notes < shell.indexOf('href: "/dashboard/material-bundles"'), "before Tutes & Papers");
  assert.match(shell, /\{ href: "\/dashboard\/notes",\s+label: "Notes",\s+icon: <NotebookPen size=\{18\} strokeWidth=\{1\.75\} \/> \}/);
});
