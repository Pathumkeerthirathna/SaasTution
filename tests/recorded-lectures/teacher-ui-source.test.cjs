/*
 * Recorded Lectures, teacher UI: source checks of the management page and the
 * Recording Studio (the repository has no DOM renderer; browser behaviour is
 * verified in the pending real-browser phase).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const DIR = ["components", "recorded-lectures"];
const manage = read(...DIR, "teacher-recordings-client.tsx");
const studio = read(...DIR, "recording-studio-client.tsx");
const engine = read(...DIR, "upload-engine.ts");
const listPage = read("app", "dashboard", "lectures", "[lectureId]", "recordings", "page.tsx");
const studioPage = read("app", "dashboard", "lectures", "[lectureId]", "recordings", "studio", "page.tsx");

test("one upload backend: the UI uploads only through the engine (existing RL-3 routes), never its own chunk requests", () => {
  for (const src of [manage, studio]) {
    assert.doesNotMatch(code(src), /\/chunks|Upload-Offset|\/complete`/);
  }
  assert.match(engine, /\/recorded-lectures\/uploads`/);
  assert.match(engine, /\/chunks`/);
  assert.match(engine, /\/complete`/);
  assert.match(code(manage), /new RecordingUploader\(/);
  assert.match(code(studio), /uploadLocalRecording\(/);
});

test("files are checked with the server's MP4 rules in the browser before any byte is sent", () => {
  const submit = code(manage).slice(code(manage).indexOf("async function onSubmit"), code(manage).indexOf("function retry"));
  const inspectAt = submit.indexOf("inspectMp4(");
  const runAt = submit.indexOf("runUpload(");
  assert.ok(inspectAt > 0 && runAt > inspectAt, "inspect before upload");
  assert.match(submit, /durationSeconds === null/);
  assert.match(submit, /maxPartBytes/);
  assert.match(submit, /already exists/);
});

test("the studio never uploads before the teacher confirms the preview", () => {
  const c = code(studio);
  const calls = c.match(/uploadLocalRecording\(/g) ?? [];
  assert.equal(calls.length, 1);
  const saveFn = c.slice(c.indexOf("async function save"), c.indexOf("async function discard"));
  assert.match(saveFn, /uploadLocalRecording\(/);
  assert.match(c, /onClick=\{\(\) => void save\(\)\}/);
  assert.match(c, /disabled=\{!state\.check\.ok \|\| uploading\}/, "a file the server would reject cannot be saved");
  assert.doesNotMatch(read(...DIR, "studio-controller.ts"), /fetch\(|uploadLocalRecording|RecordingUploader/);
});

test("no unverified camera + screen composition (no canvas capture)", () => {
  for (const src of [studio, read(...DIR, "studio-controller.ts"), read(...DIR, "studio-helpers.ts")]) {
    assert.doesNotMatch(code(src), /captureStream|<canvas|getContext\(|OffscreenCanvas/);
  }
  assert.match(studio, /NOT offered/);
});

test("studio: browser capabilities, persistence request, device release, unsupported message", () => {
  const c = code(studio);
  assert.match(c, /studioSupport\(/);
  assert.match(c, /MR\.isTypeSupported\(type\)/);
  assert.match(c, /navigator\.storage\?\.persist\?\.\(\)/);
  assert.match(c, /controller\.releaseSources\(\)/, "camera / microphone / screen released when leaving");
  assert.match(c, /SUPPORTED_BROWSERS_TEXT/);
  assert.match(c, /new MediaRecorder\(stream as unknown as MediaStream, \{ mimeType,/, "only the checked MP4 type is recorded");
  assert.match(c, /URL\.revokeObjectURL\(reviewUrl\)/);
  assert.match(c, /beforeunload/);
});

test("management: pause / resume / retry / cancel, resume with the same file, delete confirmation, preview", () => {
  const c = code(manage);
  for (const needle of [".uploader.pause()", "uploader.cancel()", "Resume upload", "fingerprintFile(", "sameFingerprint(", "Delete part", "method: \"DELETE\"", "method: \"PATCH\"", "PART_NUMBER_IN_USE", "beforeunload"]) {
    assert.ok(c.includes(needle), needle);
  }
  const video = c.match(/<video[\s\S]*?\/>/)[0];
  assert.match(video, /preload="metadata"/);
  assert.match(video, /controlsList="nodownload"/);
  assert.match(video, /src=\{preview\.previewUrl\}/);
});

test("responsive and accessible: wrapped text, labelled progress, touch-size buttons", () => {
  for (const src of [manage, studio]) {
    assert.doesNotMatch(src, /\btruncate\b|line-clamp/);
    assert.match(src, /role="progressbar"/);
    assert.match(src, /break-words/);
    const buttons = [...src.matchAll(/<button\b[^<]*?className=(?:"([^"]*)"|\{`([^`]*)`\})/g)];
    assert.ok(buttons.length > 3);
    for (const [whole, plain, template] of buttons) assert.match(plain ?? template, /min-h-\[(40|44)px\]/, whole.slice(0, 80));
  }
});

test("pages: teacher session required, ownership through the service, 404 for others", () => {
  for (const page of [listPage, studioPage]) {
    assert.match(page, /requireTeacherSession\(\)/);
    assert.match(page, /listTeacherLectureRecordings\(\{ teacherId, lectureId: params\.lectureId \}\)/);
    assert.match(page, /notFound\(\)/);
    assert.doesNotMatch(page, /"use client"/);
  }
});

test("existing features untouched: YouTube, Jitsi, lecture scheduling, Notes / Assignments / Quizzes / Attendance (git)", () => {
  const paths = [
    "lib/youtube-lecture.ts", "lib/youtube-live.ts", "app/api/youtube", "components/Jitsi", "lib/lecture-schedule.ts", "lib/lecture-validation.ts",
    "services/lecture-service.ts", "components/student-portal/lecture-list-client.tsx", "app/api/lectures/[id]/notes", "app/api/assignments", "app/api/attendance",
    "middleware.ts", "instrumentation.ts", "prisma/migrations/20261114120000_add_recorded_lectures",
  ];
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...paths], { cwd: root, encoding: "utf8" });
  assert.equal(diff.trim(), "", diff);
});

test("the lecture panel only gains the 'Recorded lectures' link (no line removed)", () => {
  const numstat = execFileSync("git", ["diff", "--numstat", "HEAD", "--", "components/lecture-management-panel.tsx"], { cwd: root, encoding: "utf8" }).trim();
  const [added, removed] = numstat.split(/\s+/).map(Number);
  assert.equal(removed, 0);
  assert.ok(added > 0 && added <= 12, numstat);
  const panel = read("components", "lecture-management-panel.tsx");
  assert.match(panel, /href=\{`\/dashboard\/lectures\/\$\{encodeURIComponent\(lecture\.id\)\}\/recordings`\}/);
});
