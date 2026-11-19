/**
 * Uploaded recorded lectures on the public class page ("Course Sessions") and
 * the teacher's privacy / viewing access settings.
 *
 *   npx tsx --tsconfig tests/ui/tsconfig.json --test tests/ui/public-recorded-lectures.test.tsx
 *
 * Static rendering (the repository has no DOM renderer): what each state
 * renders, that a Locked recording's row and prompt contain nothing that can
 * request its video, and that YouTube rows are rendered as before.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import ClassSessionsPreview from "../../components/teacherProfile/classLanding/ClassSessionsPreview";
import {
  LockedRecordingPrompt,
  UploadedRecordingPlayer,
  UploadedRecordingRow,
  formatRecordingSeconds,
  studentRecordingPath,
} from "../../components/teacherProfile/classLanding/UploadedRecordings";
import { TeacherRecordingsClient, type TeacherRecordingsInitial } from "../../components/recorded-lectures/teacher-recordings-client";
import type { ClassLectureSession, ClassLectureUploadedRecording } from "../../types/teacherProfileTypes/ClassLectureSession";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};

const LECTURE = "00000000-0000-4000-8000-000000000201";
const FREE: ClassLectureUploadedRecording = {
  source: "UPLOAD",
  id: "00000000-0000-4000-8000-000000000501",
  title: "Algebra introduction",
  partNumber: 1,
  durationSeconds: 3725,
  access: "FREE",
  streamUrl: "/api/public/recorded-lectures/00000000-0000-4000-8000-000000000501/stream",
};
const LOCKED: ClassLectureUploadedRecording = {
  source: "UPLOAD",
  id: "00000000-0000-4000-8000-000000000502",
  title: "Algebra exercises",
  partNumber: 2,
  durationSeconds: 1800,
  access: "LOCKED",
  streamUrl: null,
};

const youtubeSession: ClassLectureSession = {
  id: "lecture-yt",
  title: "Geometry",
  date: "2026-11-10T10:00:00.000Z",
  createdAt: "2026-11-10T10:00:00.000Z",
  recordings: [
    { id: "yt-1", access: "FREE", videoId: "vidFree01", youtubeUrl: "https://www.youtube.com/watch?v=vidFree01", startedAt: "2026-11-10T10:00:00.000Z", endedAt: "2026-11-10T11:00:00.000Z" },
    { id: "yt-2", access: "LOCKED", videoId: null, youtubeUrl: null, startedAt: "2026-11-10T11:00:00.000Z", endedAt: "2026-11-10T11:30:00.000Z" },
  ],
};

test("YouTube-only sessions render as before: no upload markup, same rows, counts and badges", () => {
  const html = renderToStaticMarkup(<ClassSessionsPreview lectures={[youtubeSession]} />);
  const t = text(html);
  assert.match(t, /Course Sessions/);
  assert.match(t, /1 Free/);
  assert.match(t, /2 recordings/);
  assert.match(t, /1\. Geometry FREE 1h/);
  assert.match(t, /2\. Geometry LOCKED 30m/);
  assert.equal((html.match(/>Watch</g) ?? []).length, 1);
  // The YouTube Locked label stays a plain label (unchanged behaviour), not a button.
  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /Part \d/);
  assert.doesNotMatch(html, /\/api\/public\/recorded-lectures/);
});

test("uploads appear inside their course session (no separate group); counts include them; no video URL in the page markup", () => {
  const session: ClassLectureSession = { ...youtubeSession, uploads: [FREE, LOCKED] };
  const uploadsOnly: ClassLectureSession = { id: LECTURE, title: "Algebra", date: "2026-11-12T10:00:00.000Z", createdAt: "2026-11-12T10:00:00.000Z", recordings: [], uploads: [FREE] };
  const html = renderToStaticMarkup(<ClassSessionsPreview lectures={[uploadsOnly, session]} />);
  const t = text(html);

  assert.match(t, /3 Free/, "1 YouTube + 2 uploaded Unlocked");
  assert.match(t, /4 recordings/, "2 YouTube + 2 uploaded in the Geometry session");
  assert.match(t, /1 recording\b/, "the uploads-only session");
  assert.match(t, /Part 1\. Algebra introduction FREE 1h 2m/);
  assert.match(t, /Part 2\. Algebra exercises LOCKED 30m/);
  // Same card: one "Course Sessions" section, the upload rows inside the lecture's list.
  assert.equal((t.match(/Course Sessions/g) ?? []).length, 1);
  assert.ok(t.indexOf("2. Geometry") < t.indexOf("Part 1. Algebra introduction FREE 1h 2m", t.indexOf("Geometry")), "after the YouTube rows");
  // The stream URL is only used once Watch is pressed; a Locked row has none at all.
  assert.doesNotMatch(html, /\/api\/public\/recorded-lectures/);
});

test("upload row: Unlocked shows Watch; Locked shows a lock and a Locked button that opens a dialog", () => {
  const free = renderToStaticMarkup(<UploadedRecordingRow recording={FREE} onWatch={noop} onLocked={noop} />);
  assert.match(text(free), /Part 1\. Algebra introduction FREE 1h 2m Watch/);
  assert.doesNotMatch(free, /aria-haspopup/);

  const locked = renderToStaticMarkup(<UploadedRecordingRow recording={LOCKED} onWatch={noop} onLocked={noop} />);
  assert.match(text(locked), /Part 2\. Algebra exercises LOCKED 30m Locked/);
  assert.match(locked, /<button type="button" aria-haspopup="dialog"/);
  assert.doesNotMatch(text(locked), /Watch/);
  assert.doesNotMatch(locked, /\/api\//);
});

test("locked prompt: Log in and Register actions, the student portal for enrolled students, and never the video", () => {
  const html = renderToStaticMarkup(<LockedRecordingPrompt recording={LOCKED} lectureId={LECTURE} onClose={noop} onRegister={noop} />);
  const t = text(html);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(t, /This recording is locked/);
  assert.match(t, /Part 2\. Algebra exercises/);
  assert.match(html, /<a[^>]*href="\/login"[^>]*>.*Log in<\/a>/);
  assert.match(html, /<button type="button"[^>]*>.*Register<\/button>/);
  assert.match(html, new RegExp(`href="${studentRecordingPath(LECTURE, LOCKED.id).replace(/[?]/g, "\\?")}"`));
  assert.doesNotMatch(html, /\/api\/|<video|youtube/i, "nothing that requests the recording");
  for (const button of html.match(/<(a|button)\b[^>]*class="[^"]*min-h-\[40px\][^"]*"/g) ?? []) assert.ok(button);
});

test("player: the public stream URL in a <video> (metadata preload, no download control, inline on phones)", () => {
  const html = renderToStaticMarkup(<UploadedRecordingPlayer recording={FREE as Extract<ClassLectureUploadedRecording, { access: "FREE" }>} onClose={noop} />);
  const video = html.match(/<video[^>]*>/)?.[0] ?? "";
  assert.match(video, new RegExp(`src="${FREE.streamUrl}"`));
  assert.match(video, /preload="metadata"/);
  assert.match(video, /controlsList="nodownload"/);
  assert.match(video, /playsinline=""/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Close player"/);
});

test("helpers: duration text and the student portal path", () => {
  assert.equal(formatRecordingSeconds(3725), "1h 2m");
  assert.equal(formatRecordingSeconds(3600), "1h");
  assert.equal(formatRecordingSeconds(20), "1m");
  assert.equal(formatRecordingSeconds(null), null);
  assert.equal(formatRecordingSeconds(0), null);
  assert.equal(studentRecordingPath("a b", "c&d"), "/student/recorded-lectures/a%20b?recording=c%26d");
});

test("teacher settings: Privacy (Private / Public) and Viewing access (Locked / Unlocked) per part, with the current values", () => {
  const recording = (id: string, partNumber: number, visibility: "PUBLIC" | "PRIVATE", access: "FREE" | "LOCKED", state: "READY" | "FAILED" = "READY") => ({
    id, lectureId: LECTURE, title: `Part title ${partNumber}`, partNumber, fileName: "a.mp4", sizeBytes: "1000", durationSeconds: 60, width: null, height: null,
    state, failureCode: state === "FAILED" ? "MP4_INVALID" : null, failureMessage: state === "FAILED" ? "x" : null, createdAt: "2026-11-12T10:00:00.000Z",
    readyAt: state === "READY" ? "2026-11-12T10:00:00.000Z" : null, failedAt: null, upload: null, previewUrl: state === "READY" ? `/api/recorded-lectures/${id}/stream` : null,
    visibility, access,
  });
  const initial: TeacherRecordingsInitial = {
    lecture: { id: LECTURE, title: "Algebra", date: "2026-11-12T10:00:00.000Z", className: "Grade 10" },
    recordings: [recording("r1", 1, "PRIVATE", "LOCKED"), recording("r2", 2, "PUBLIC", "FREE"), recording("r3", 3, "PUBLIC", "LOCKED", "FAILED")],
    nextPartNumber: 4,
    limits: { maxPartBytes: 4_000_000_000, chunkBytes: 8_388_608, maxPartsPerLecture: null, maxMoovBytes: 50_000_000 },
  };
  const html = renderToStaticMarkup(<TeacherRecordingsClient teacherId="t" initial={initial} />);
  const t = text(html);
  assert.equal((html.match(/<label[^>]*>Privacy<select/g) ?? []).length, 2, "not offered for a FAILED part");
  assert.equal((html.match(/<label[^>]*>Viewing access<select/g) ?? []).length, 2);
  const selects = html.match(/<select[\s\S]*?<\/select>/g) ?? [];
  assert.equal(selects.length, 4);
  const selected = (select: string) => select.match(/<option value="([A-Z]+)" selected="">/)?.[1];
  assert.deepEqual(selects.map(selected), ["PRIVATE", "LOCKED", "PUBLIC", "FREE"]);
  assert.match(selects[1], />Locked<\/option>.*>Unlocked<\/option>/);
  assert.match(selects[0], />Private<\/option>.*>Public<\/option>/);
  assert.match(t, /Not shown on your public class page\./);
  assert.match(t, /anyone can watch it there/);
  assert.match(t, /Enrolled students can always watch every ready part\./);
});
