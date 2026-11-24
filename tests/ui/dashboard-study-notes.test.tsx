/**
 * Notes redesign Stage 4: the student dashboard's notes widget
 * (components/student-portal/dashboard-study-notes.tsx), the "Notes to view"
 * count tile and the Notes page's ?classId= pre-selection. No DOM library:
 * the pure helpers, a react-dom/server first render and source checks. The
 * widget API's order and the counts' semantics run on real PostgreSQL in
 * tests/notes/dashboard-notes.db.test.cjs; the counts query's shape in
 * tests/notes/dashboard-notes.test.cjs.
 *
 *   npm run test:ui   (also npm run test:notes-ui)
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardStudyNotes, studyNoteContext, studyNoteDateLabel, studyNotesPageHref } from "../../components/student-portal/dashboard-study-notes";
import { StudentNotesClient, firstStudentNotesClass } from "../../components/student-portal/notes/student-notes-client";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

test("date line: the upload date in Sri Lankan time; a legacy lecture note falls back to its lecture's date; a General Note never shows its lecture's (class creation) date", () => {
  assert.equal(studyNoteDateLabel({ uploadedAt: "2026-11-30T19:00:00.000Z", isGeneral: false, date: "2026-10-10T03:30:00.000Z" }), "Uploaded 1 Dec 2026", "after Sri Lankan midnight");
  assert.equal(studyNoteDateLabel({ uploadedAt: "2026-11-20T10:00:00.000Z", isGeneral: true, date: "2026-01-05T00:00:00.000Z" }), "Uploaded 20 Nov 2026");
  assert.equal(studyNoteDateLabel({ uploadedAt: null, isGeneral: false, date: "2026-10-10T03:30:00.000Z" }), "Lecture 10 Oct 2026");
  assert.equal(studyNoteDateLabel({ uploadedAt: null, isGeneral: true, date: "2026-01-05T00:00:00.000Z" }), null, "no date rather than the class's creation");
  assert.equal(studyNoteDateLabel({ date: "2026-10-10T03:30:00.000Z" }), "Lecture 10 Oct 2026", "an older API response (no new fields) behaves as before");
});

test("context line: General Notes are named as such; lecture notes keep the lecture's title", () => {
  assert.equal(studyNoteContext({ className: "Physics", lectureTitle: "General Notes", isGeneral: true }), "Physics · General Notes");
  assert.equal(studyNoteContext({ className: "Physics", lectureTitle: "Kinematics", isGeneral: false }), "Physics · Kinematics");
});

test("View all opens the Notes page (never the lecture list, which hides default lectures), on the notes' class when they share one", () => {
  assert.equal(studyNotesPageHref([]), "/student/notes");
  assert.equal(studyNotesPageHref([{ classId: "C1" }, { classId: "C1" }]), "/student/notes?classId=C1");
  assert.equal(studyNotesPageHref([{ classId: "C1" }, { classId: "C2" }]), "/student/notes");
  assert.equal(studyNotesPageHref([{ classId: undefined }]), "/student/notes");
  assert.equal(studyNotesPageHref([{ classId: "a b" }]), "/student/notes?classId=a%20b");
  const html = renderToStaticMarkup(<DashboardStudyNotes />);
  assert.match(html, /href="\/student\/notes"/);
  assert.doesNotMatch(html, /notes=unviewed/);
  const widget = source("components", "student-portal", "dashboard-study-notes.tsx");
  assert.match(widget, /href=\{studyNotesPageHref\(notes\)\}/);
  assert.doesNotMatch(widget, /["`]\/student\/lectures/, "no link to the lecture list page (the file API path is fine)");
  assert.match(widget, /href=\{`\/api\/student\/lectures\/\$\{note\.lectureId\}\/notes\/\$\{note\.id\}\/file`\}/, "opening a note: the existing file route, unchanged");
});

test("the 'Notes to view' count tile opens the Notes page", () => {
  const section = source("components", "student-portal", "live-dashboard-section.tsx");
  const tile = section.slice(section.indexOf('label="Notes to view"'), section.indexOf('label="Notes to view"') + 300);
  assert.match(tile, /href="\/student\/notes"/);
  assert.doesNotMatch(section, /notes=unviewed/);
});

test("the widget keeps its compact layout: same card, list, lock badge and empty text", () => {
  const widget = source("components", "student-portal", "dashboard-study-notes.tsx");
  assert.match(widget, /Study material notes/);
  assert.match(widget, /\{notes\.length\} unviewed/);
  assert.match(widget, /<LockedResourceBadge lock=\{note\.resourceAccess\} \/>/);
  assert.match(widget, /You&apos;ve viewed all lecture notes\./);
  assert.match(widget, /\{studyNoteDateLabel\(note\) \? <p className="mt-0\.5 text-\[11px\] text-slate-400">\{studyNoteDateLabel\(note\)\}<\/p> : null\}/);
});

test("the Notes page opens on a linked class only when it is one of the student's classes", () => {
  const classes = [{ id: "C1", name: "Physics" }, { id: "C2", name: "Chemistry" }];
  assert.equal(firstStudentNotesClass(classes, "C2"), "C2");
  assert.equal(firstStudentNotesClass(classes, "C9"), "", "an unknown or foreign class is ignored");
  assert.equal(firstStudentNotesClass(classes, null), "");
  assert.equal(firstStudentNotesClass([classes[0]], "C9"), "C1", "the only class, as before");
  const html = renderToStaticMarkup(<StudentNotesClient classes={classes} initialClassId="C2" />);
  assert.match(html, /<option value="C2" selected="">Chemistry<\/option>/);
  assert.match(html, /data-notes-section="general"/, "General Notes first");
  assert.match(html, /aria-label="Loading notes"/);
});
