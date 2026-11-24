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
  for (const needle of [".uploader.pause()", "uploader.cancel()", "Resume upload", "fingerprintFile(", "sameFingerprint(", "Permanently delete part", "RECORDING_DELETION_WARNING", "method: \"DELETE\"", "method: \"PATCH\"", "PART_NUMBER_IN_USE", "beforeunload"]) {
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
  // Changed on purpose by unified storage Stage 2 (Notes / submission files; tests/storage-migration),
  // not by Recorded Lectures; everything else in the list must stay unchanged.
  const stage2 = [
    "services/lecture-service.ts",
    "components/student-portal/lecture-list-client.tsx",
    "app/api/lectures/[id]/notes/route.ts",
    "app/api/assignments/[assignmentId]/submit/route.ts",
    "app/api/assignments/[assignmentId]/submit/file/route.ts",
    // Stage 3.6 (permanent deletion; tests/storage-quota/permanent-deletion.test.cjs): the note DELETE
    // route and the maintenance scheduler's wiring.
    "app/api/lectures/[id]/notes/[noteId]/route.ts",
    "instrumentation.ts",
    // Payment-due access control (one access check; tests/class-access): a
    // restricted student cannot record a classroom visit.
    "app/api/attendance/route.ts",
    // Monthly resource access (tests/class-access/resource-access.test.cjs):
    // the classroom notes panel shows a locked month's note without its links.
    "components/Jitsi/classroom/student/StudentNotesPanel.tsx",
    // Resource creation timestamps (tests/class-access/resource-timestamps.test.cjs):
    // YouTubeRecording.createdAt is written explicitly from serverNow() on create.
    "lib/youtube-lecture.ts",
  ].map((file) => `:(exclude,literal)${file}`);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...paths, ...stage2], { cwd: root, encoding: "utf8" });
  assert.equal(diff.trim(), "", diff);
});

test("the lecture panel keeps the 'Recorded lectures' link; its YouTube sections are the shared components (one implementation)", () => {
  // Recordings navigation consolidation: the panel's inline YouTube recordings / live streams (their
  // loading, privacy / visibility / access controls and the player modal) moved, unchanged, into
  // components/youtube (tests/ui/recordings-navigation.test.tsx), which the Recordings > Live Recordings
  // and YouTube Live Sessions pages reuse. That removed lines from the panel, so the former "no line
  // removed" (git numstat against 9610568) no longer applies; what it protected is pinned here instead.
  const panel = read("components", "lecture-management-panel.tsx");
  assert.match(panel, /href=\{`\/dashboard\/lectures\/\$\{encodeURIComponent\(lecture\.id\)\}\/recordings`\}/);
  assert.match(panel, /<LectureYouTubeRecordingsPanel lectureId=\{lecture\.id\} onError=\{setErrorMessage\} \/>/);
  assert.match(panel, /<LectureLiveBroadcastsPanel lectureId=\{lecture\.id\} onError=\{setErrorMessage\} onSuccess=\{setSuccessMessage\} \/>/);
  assert.doesNotMatch(panel, /\/api\/lectures\/\$\{lectureId\}\/(recordings|lives)/, "no second implementation in the panel");
  assert.doesNotMatch(panel, /youtube\.com\/embed/, "the player modal is the shared one");
  // Nothing else of the Recorded Lectures integration changed: still exactly one link to the recordings page.
  assert.equal((panel.match(/\/recordings`\}/g) ?? []).length, 1);
});

// ---- Video format & conversion guide ------------------------------------------------------------------

const guide = read(...DIR, "upload-format-guide.tsx");

test("format guide: placed under the upload description, collapsed by default, accessible toggle", () => {
  const c = code(manage);
  const description = c.indexOf("been uploaded and checked.");
  const guideAt = c.indexOf("<UploadFormatGuide maxSizeLabel={formatBytes(initial.limits.maxPartBytes)} />");
  const formAt = c.indexOf("<form onSubmit={onSubmit}");
  assert.ok(description > 0 && guideAt > description && formAt > guideAt, "description, then the guide, then the form");
  const g = code(guide);
  assert.match(g, /useState\(false\)/, "collapsed by default");
  assert.match(g, /aria-expanded=\{open\}/);
  assert.match(g, /aria-controls=\{panelId\}/);
  assert.match(g, /id=\{panelId\} hidden=\{!open\}/);
  assert.match(g, /<CircleHelp /);
  assert.match(g, /Video format &amp; conversion guide/);
  assert.match(g, /min-h-\[44px\]/);
});

test("format guide: the supported format, the size from the server's limit, and the conversion advice", () => {
  for (const text of ["MP4", "H.264 (AVC)", "AAC", "per part", "If your video is not supported, convert it to the recommended format before uploading."]) {
    assert.ok(guide.includes(text), text);
  }
  assert.match(guide, /\$\{maxSizeLabel\} per part/, "the limit comes from the server configuration, not a hard-coded number");
  assert.match(guide, /size of the original video, the speed of your computer and the quality/);
});

test("format guide: HandBrake steps, official link opened safely, privacy note", () => {
  require("tsx/cjs/api").register();
  const G = require(path.join(root, ...DIR, "upload-format-guide.tsx"));
  assert.equal(G.HANDBRAKE_URL, "https://handbrake.fr/");
  assert.deepEqual(G.HANDBRAKE_STEPS, [
    "Open HandBrake.",
    "Select the original video.",
    "Under Summary, set Format to MP4.",
    "Under Video, select H.264 (x264).",
    "Under Audio, select AAC.",
    "Choose where to save the converted file.",
    "Click Start Encode.",
    "Upload the converted MP4 to SLClassroom.",
  ]);
  assert.match(guide, /href=\{HANDBRAKE_URL\}\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(guide, /opens in a new tab/);
  assert.match(guide, /Avoid uploading private classroom recordings to unknown online\s+conversion websites/);
});

test("format guide: information only (no validation, upload or limit logic)", () => {
  const g = code(guide);
  assert.doesNotMatch(g, /fetch\(|inspectMp4|RecordingUploader|maxPartBytes|4_000_000_000|4000000000/);
  assert.doesNotMatch(g, /\btruncate\b|line-clamp/);
});
