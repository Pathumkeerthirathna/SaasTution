/**
 * The teacher's Recorded Lectures page (Recorded Lectures redesign Stage 2):
 * app/dashboard/recorded-lectures, components/recorded-lectures/
 * teacher-recordings-workspace.tsx, the class-scoped mode of
 * TeacherRecordingsClient, the upload engine's start URL and the sidebar.
 * No DOM library: react-dom/server renders, the pure helpers and source
 * checks. The engine's real requests against the real routes (a General
 * upload through the class-scoped start, to READY): tests/recorded-lectures/
 * class-recordings.test.cjs. Clicking through the page in a browser remains a
 * manual check.
 *
 *   npm run test:ui   (also npm run test:recordings-ui)
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { TeacherRecordingDto } from "../../lib/recorded-lectures/teacher-dto";
import {
  TeacherRecordingsClient,
  teacherRecordingsListUrl,
  teacherRecordingsStartUrl,
  teacherRecordingsStoreKey,
  type TeacherRecordingsInitial,
} from "../../components/recorded-lectures/teacher-recordings-client";
import { classRecordingUploadStartUrl, uploadMessage } from "../../components/recorded-lectures/upload-engine";
import {
  RECORDINGS_CLASSES_URL,
  TeacherRecordingsWorkspace,
  classRecordingsUrl,
  recordingsErrorMessage,
  recordingsLectureLabel,
  recordingsLecturesUrl,
  toRecordingsInitial,
} from "../../components/recorded-lectures/teacher-recordings-workspace";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const CLASS = "11111111-1111-4111-8111-111111111111";
const DEFAULT = "22222222-2222-4222-8222-222222222222";
const LECTURE = "33333333-3333-4333-8333-333333333333";

function recordingDto(extra: Partial<TeacherRecordingDto> = {}): TeacherRecordingDto {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    lectureId: DEFAULT,
    title: "Course intro",
    partNumber: 1,
    fileName: "intro.mp4",
    sizeBytes: "1048576",
    durationSeconds: 600,
    width: 1280,
    height: 720,
    state: "READY",
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    readyAt: "2026-11-20T10:05:00.000Z",
    failedAt: null,
    upload: null,
    previewUrl: "/api/recorded-lectures/44444444-4444-4444-8444-444444444444/stream",
    visibility: "PRIVATE",
    access: "LOCKED",
    ...extra,
  };
}

const LIMITS = { maxPartBytes: 4_000_000_000, chunkBytes: 8_388_608, maxPartsPerLecture: null, maxMoovBytes: 64_000_000 };
const generalInitial: TeacherRecordingsInitial = toRecordingsInitial({
  class: { id: CLASS, name: "Physics" },
  section: "GENERAL",
  lecture: { id: DEFAULT, title: "General Notes", date: "2026-01-05T00:00:00.000Z", isDefault: true },
  recordings: [recordingDto()],
  nextPartNumber: 2,
  limits: LIMITS,
});
const lectureInitial: TeacherRecordingsInitial = toRecordingsInitial({
  class: { id: CLASS, name: "Physics" },
  section: "LECTURE",
  lecture: { id: LECTURE, title: "Kinematics", date: "2026-11-23T03:30:00.000Z", isDefault: false },
  recordings: [recordingDto({ lectureId: LECTURE })],
  nextPartNumber: 2,
  limits: LIMITS,
});

// ---- Endpoints ---------------------------------------------------------------------------------------

test("endpoints: General Recordings list and start through the class (no lecture id); lecture recordings keep the lecture's own start", () => {
  assert.equal(teacherRecordingsListUrl(DEFAULT, { classId: CLASS, section: "GENERAL" }), `/api/classes/${CLASS}/recorded-lectures`);
  assert.equal(teacherRecordingsStartUrl({ classId: CLASS, section: "GENERAL" }), `/api/classes/${CLASS}/recorded-lectures/uploads`);
  assert.equal(teacherRecordingsListUrl(LECTURE, { classId: CLASS, section: "LECTURE" }), `/api/classes/${CLASS}/recorded-lectures?lectureId=${LECTURE}`);
  assert.equal(teacherRecordingsStartUrl({ classId: CLASS, section: "LECTURE" }), undefined, "the engine's default: /api/lectures/{id}/recorded-lectures/uploads");
  assert.equal(teacherRecordingsListUrl(LECTURE), `/api/lectures/${LECTURE}/recorded-lectures`, "the lecture page: unchanged");
  assert.equal(teacherRecordingsStartUrl(), undefined);
  assert.equal(classRecordingUploadStartUrl(CLASS, LECTURE), `/api/classes/${CLASS}/recorded-lectures/uploads?lectureId=${LECTURE}`);
  assert.equal(classRecordingUploadStartUrl("a/b"), "/api/classes/a%2Fb/recorded-lectures/uploads");
  for (const url of [teacherRecordingsListUrl(DEFAULT, { classId: CLASS, section: "GENERAL" }), teacherRecordingsStartUrl({ classId: CLASS, section: "GENERAL" }) ?? ""]) {
    assert.ok(!url.includes(DEFAULT), "the default lecture's id is never sent");
  }
});

test("resumable uploads: General uploads are remembered under the class's General key, lecture uploads under the lecture (as before)", () => {
  assert.equal(teacherRecordingsStoreKey(DEFAULT, { classId: CLASS, section: "GENERAL" }), `general:${CLASS}`);
  assert.equal(teacherRecordingsStoreKey(LECTURE, { classId: CLASS, section: "LECTURE" }), LECTURE);
  assert.equal(teacherRecordingsStoreKey(LECTURE), LECTURE);
  const client = code(source("components", "recorded-lectures", "teacher-recordings-client.tsx"));
  assert.match(client, /putFileUpload\(\{ uploadId, teacherId, lectureId: storeKey,/);
  assert.match(client, /listFileUploads\(teacherId, storeKey\)/);
});

test("the upload engine: an optional start URL; without it exactly the lecture-scoped start; every other request unchanged", () => {
  const engine = code(source("components", "recorded-lectures", "upload-engine.ts"));
  assert.match(engine, /this\.call\(this\.deps\.startUrl \?\? `\/api\/lectures\/\$\{encodeURIComponent\(this\.lectureId\)\}\/recorded-lectures\/uploads`, \{/);
  assert.match(engine, /return `\/api\/recorded-lectures\/uploads\/\$\{encodeURIComponent\(this\.snapshot\.uploadId \?\? ""\)\}`;/);
  assert.equal(uploadMessage("DEFAULT_LECTURE_MISSING"), "General recordings are not set up for this class yet.");
  assert.equal(uploadMessage("CLASS_NOT_FOUND"), "This class is no longer available.");
  const client = code(source("components", "recorded-lectures", "teacher-recordings-client.tsx"));
  assert.match(client, /fetch: \(input, init\) => fetch\(input, init\),\s*startUrl,/);
  assert.match(code(source("components", "recorded-lectures", "studio-upload.ts")), /new RecordingUploader\(/, "the studio keeps the engine's default (lecture) start");
  assert.doesNotMatch(code(source("components", "recorded-lectures", "studio-upload.ts")), /startUrl/);
});

// ---- The client in its scopes ----------------------------------------------------------------------

test("General scope: a section header without a lecture date or studio link; no publication controls; edit, delete and preview kept", () => {
  const html = renderToStaticMarkup(<TeacherRecordingsClient teacherId="T1" initial={generalInitial} scope={{ classId: CLASS, section: "GENERAL" }} />);
  assert.match(html, /data-recordings-scope="general"/);
  assert.match(text(html), /General recordings Physics · recordings for the whole class, not tied to a lecture/);
  assert.doesNotMatch(text(html), /5 Jan 2026|2026-01-05|General Notes/, "never the default lecture's date or internal title");
  // (The format guide's "Privacy:" tip about converting videos is not a publication control.)
  assert.doesNotMatch(html, /Viewing access|<option value="PUBLIC">|public class page\./, "publication controls are hidden (the server refuses them)");
  assert.doesNotMatch(html, /Record class|recordings\/studio/);
  assert.doesNotMatch(html, /href="\/dashboard\/lectures"/, "no back link to the lecture list");
  for (const control of ["Preview", "Edit", "Delete"]) assert.match(text(html), new RegExp(control));
  assert.match(text(html), /Part 1 · Course intro/, "part numbers kept");
  assert.match(text(html), /Next free part number: 2/);
});

test("Lecture scope: the lecture's title and date, its studio link and the publication controls, as on the lecture page", () => {
  const html = renderToStaticMarkup(<TeacherRecordingsClient teacherId="T1" initial={lectureInitial} scope={{ classId: CLASS, section: "LECTURE" }} />);
  assert.match(html, /data-recordings-scope="lecture"/);
  assert.match(text(html), /Kinematics Physics ·/);
  assert.match(html, /Privacy/);
  assert.match(html, /Viewing access/);
  assert.match(html, new RegExp(`href="/dashboard/lectures/${LECTURE}/recordings/studio"`));
});

test("no scope (the existing lecture page): its header, back link and controls are unchanged", () => {
  const html = renderToStaticMarkup(<TeacherRecordingsClient teacherId="T1" initial={{ ...lectureInitial, lecture: { ...lectureInitial.lecture } }} />);
  assert.doesNotMatch(html, /data-recordings-scope/);
  assert.match(html, /href="\/dashboard\/lectures"/);
  assert.match(text(html), /Recorded lectures — Kinematics/);
  assert.match(html, /Privacy/);
  const page = source("app", "dashboard", "lectures", "[lectureId]", "recordings", "page.tsx");
  assert.match(page, /<TeacherRecordingsClient teacherId=\{teacherId\} initial=\{initial\} \/>/, "the lecture page passes no scope");
});

test("upload state: one submission at a time; uploads report while sending; a scoped section pauses its uploads when it is left", () => {
  const client = code(source("components", "recorded-lectures", "teacher-recordings-client.tsx"));
  assert.match(client, /if \(submittingRef\.current\) return;\s*submittingRef\.current = true;\s*try \{\s*await submitUpload\(\);\s*\} finally \{\s*submittingRef\.current = false;/);
  assert.match(client, /onSendingChange\?\.\(sending\);/);
  // Unmount (switching class / lecture): the section reports "not sending", so the page does not keep asking
  // (a cleanup only; the uploads themselves are paused by the separate unmount effect, still resumable).
  assert.match(client, /useEffect\(\(\) => \{\s*onSendingChange\?\.\(sending\);\s*return \(\) => onSendingChange\?\.\(false\);\s*\}, \[sending, onSendingChange\]\);/);
  assert.match(client, /if \(!scope\) return;\s*return \(\) => \{\s*for \(const entry of uploadsRef\.current\) entry\.uploader\.pause\(\);/);
  assert.match(client, /disabled=\{checking\}/, "the existing disabled state while the MP4 is checked");
  // The existing per-upload controls and messages are unchanged.
  for (const label of ["Pause", "Resume", "Cancel upload", "Resume upload", "Delete permanently"]) assert.ok(client.includes(label), label);
});

// ---- The workspace -----------------------------------------------------------------------------------

test("workspace: first render: the heading and the class selector only; nothing loads before a class is chosen", () => {
  const html = renderToStaticMarkup(<TeacherRecordingsWorkspace teacherId="T1" />);
  assert.match(html, /<h1 id="recordings-page-heading"[^>]*>Recorded Lectures<\/h1>/);
  assert.match(html, /data-recordings-class-select/);
  assert.match(text(html), /Loading classes…/);
  assert.doesNotMatch(html, /data-recordings-section=/);
});

test("workspace: classes and normal lectures from the existing APIs; General and lecture recordings from the class-scoped API", () => {
  assert.equal(RECORDINGS_CLASSES_URL, "/api/classes?page=1&pageSize=100");
  assert.equal(recordingsLecturesUrl(CLASS, 2), `/api/lectures?classId=${CLASS}&page=2&pageSize=100&sortOrder=desc`);
  assert.equal(classRecordingsUrl(CLASS), `/api/classes/${CLASS}/recorded-lectures`);
  assert.equal(classRecordingsUrl(CLASS, LECTURE), `/api/classes/${CLASS}/recorded-lectures?lectureId=${LECTURE}`);
  assert.equal(recordingsLectureLabel({ id: LECTURE, title: "Kinematics", date: "2026-11-23T20:00:00.000Z" }), "Kinematics · 24 Nov 2026");
  assert.equal(generalInitial.lecture.title, "General recordings", "never the default lecture's internal title");
  const ws = code(source("components", "recorded-lectures", "teacher-recordings-workspace.tsx"));
  assert.doesNotMatch(ws, /isDefault: true|defaultLecture/i);
  assert.match(ws, /useSectionRecordings\(classId \? classRecordingsUrl\(classId\) : null, generalAttempt\)/);
  assert.match(ws, /useSectionRecordings\(classId && lectureId \? classRecordingsUrl\(classId, lectureId\) : null, lectureAttempt\)/);
});

test("workspace: each section is the existing client, keyed by its class / lecture; General in the GENERAL scope", () => {
  const ws = code(source("components", "recorded-lectures", "teacher-recordings-workspace.tsx"));
  assert.match(ws, /<TeacherRecordingsClient\s+key=\{`general:\$\{classId\}`\}\s+teacherId=\{teacherId\}\s+initial=\{initial\}\s+scope=\{\{ classId, section: "GENERAL" \}\}/);
  assert.match(ws, /<TeacherRecordingsClient\s+key=\{`lecture:\$\{classId\}:\$\{lectureId\}`\}\s+teacherId=\{teacherId\}\s+initial=\{initial\}\s+scope=\{\{ classId, section: "LECTURE" \}\}/);
});

test("workspace: switching clears stale lists at once, aborts older requests, and asks first while an upload is sending", () => {
  const ws = code(source("components", "recorded-lectures", "teacher-recordings-workspace.tsx"));
  const hook = ws.slice(ws.indexOf("function useSectionRecordings"), ws.indexOf("const SWITCH_WHILE_UPLOADING"));
  assert.match(hook, /const controller = new AbortController\(\);\s*setLoad\(\{ state: "loading" \}\);/);
  assert.match(hook, /if \(!controller\.signal\.aborted\) setLoad\(\{ state: "ready", data: toRecordingsInitial\(data\) \}\);/);
  assert.match(hook, /return \(\) => controller\.abort\(\);/);
  assert.match(ws, /function chooseClass\(next: string\) \{\s*if \(next === classId \|\| !confirmLeave\(\["general", "lecture"\]\)\) return;\s*setClassId\(next\);\s*setLectureId\(""\);\s*setLecturePage\(1\);/);
  assert.match(ws, /function chooseLecture\(next: string\) \{\s*if \(next === lectureId \|\| !confirmLeave\(\["lecture"\]\)\) return;/);
  assert.match(ws, /return !sending \|\| window\.confirm\(SWITCH_WHILE_UPLOADING\);/);
});

test("workspace: loading, empty and error states, with retries; errors by status", () => {
  const ws = code(source("components", "recorded-lectures", "teacher-recordings-workspace.tsx"));
  for (const phrase of [
    "You have no classes yet. Create a class first, then add its recordings here.",
    "Select a class to manage its recordings.",
    "This class has no lectures yet.",
    "Select a lecture to manage its recordings.",
    "Loading recordings…",
    "Could not load your classes.",
    "Could not load the lectures of this class.",
  ]) {
    assert.ok(ws.includes(phrase), phrase);
  }
  assert.equal((ws.match(/Try again/g) ?? []).length, 3, "classes, lectures, a section's recordings");
  assert.equal(recordingsErrorMessage(401, "x", "f"), "Your session has ended. Please sign in again.");
  assert.equal(recordingsErrorMessage(503, null, "f"), "Recorded lectures are not available right now. Please try again later.");
  assert.equal(recordingsErrorMessage(409, "This class has no General Notes lecture yet. Ask the administrator to set it up.", "f"), "This class has no General Notes lecture yet. Ask the administrator to set it up.");
  assert.equal(recordingsErrorMessage(500, null, "f"), "f");
});

test("workspace: responsive, sections visually distinct, nothing truncated", () => {
  const ws = code(source("components", "recorded-lectures", "teacher-recordings-workspace.tsx"));
  assert.match(ws, /border-emerald-200 bg-emerald-50\/30 p-3" data-recordings-section="general"/);
  assert.match(ws, /border-brand-200 bg-brand-50\/20 p-3" data-recordings-section="lecture"/);
  assert.match(ws, /flex flex-col gap-2 p-3 sm:flex-row sm:items-end sm:px-4/);
  assert.doesNotMatch(ws, /\btruncate\b|line-clamp|text-ellipsis|\bhidden sm:|\bhidden md:|\bhidden lg:/);
});

// ---- Page and navigation ---------------------------------------------------------------------------------

test("page and sidebar: Recordings > Recorded Lectures needs a teacher session; the Recordings group after Notes and Assignments (sidebar reorganization)", () => {
  // Recordings navigation consolidation: the page moved to /dashboard/recordings/recorded-lectures
  // (the former /dashboard/recorded-lectures redirects there; tests/ui/recordings-navigation.test.tsx).
  const page = code(source("app", "dashboard", "recordings", "recorded-lectures", "page.tsx"));
  assert.match(page, /teacherId = \(await requireTeacherSession\(\)\)\.teacherId;/);
  assert.match(page, /<TeacherRecordingsWorkspace teacherId=\{teacherId\} \/>/);
  const shell = source("components", "dashboard-shell.tsx");
  const notes = shell.indexOf('href: "/dashboard/notes"');
  const recordings = shell.indexOf('href: "/dashboard/recordings"');
  assert.ok(recordings > notes && recordings > shell.indexOf('href: "/dashboard/assignments"'), "Notes, Assignments, Recordings");
  assert.ok(recordings < shell.indexOf('href: "/dashboard/material-bundles"'));
  assert.match(shell, /\{ href: "\/dashboard\/recordings\/recorded-lectures", label: "Recorded Lectures" \}/);
  assert.doesNotMatch(shell, /href: "\/dashboard\/recorded-lectures"/, "no flat Recorded Lectures item any more");
  // The lecture-specific recording pages are still there.
  assert.match(source("components", "lecture-management-panel.tsx"), /\/recordings`\}/);
});
