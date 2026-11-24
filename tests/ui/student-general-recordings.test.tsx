/**
 * Recorded Lectures redesign Stage 3: the student General Recordings on the
 * existing /student/recorded-lectures pages: the class page's two sections
 * (ClassRecordingsClient), the player header (RecordingPlayer), the dashboard
 * widget's merge, and the shared helpers. No DOM library: react-dom/server
 * renders, the pure helpers and source checks. The loaders, the API sections,
 * locks, enrolment and Range playback of General Recordings run against the
 * in-memory database in tests/recorded-lectures/student-general-recordings.test.cjs
 * and student-stream.test.cjs. Clicking through the pages in a browser remains
 * a manual check.
 *
 *   npm run test:ui   (also npm run test:recordings-ui)
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { ClassRecordingsClient } from "../../components/student-portal/recorded-lectures/class-recordings-client";
import { RecordingPlayer } from "../../components/student-portal/recorded-lectures/recording-player";
import {
  isGeneralRecording,
  listApiUrl,
  mergeDashboardRecordings,
  recordingDateLabel,
  type RecordedLecture,
} from "../../components/student-portal/recorded-lectures/recording-helpers";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const CLASS = { id: "11111111-1111-4111-8111-111111111111", name: "Physics" };
const DEFAULT = "22222222-2222-4222-8222-222222222222";
const LECTURE = "33333333-3333-4333-8333-333333333333";
const CLASS_CREATED = "2026-01-05T00:00:00.000Z";
const open = { locked: false, year: 2026, month: 11 };

let seq = 0;
function rec(extra: Partial<RecordedLecture> & { general?: boolean; date?: string; part?: number } = {}): RecordedLecture {
  seq += 1;
  const general = extra.general === true;
  const date = extra.date ?? (general ? "2026-11-20T04:30:00.000Z" : "2026-11-22T03:30:00.000Z");
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    title: general ? `General ${seq}` : `Kinematics part ${seq}`,
    partNumber: extra.part ?? 1,
    sizeBytes: "1000",
    durationSeconds: 600,
    width: 1280,
    height: 720,
    readyAt: date,
    isGeneral: general,
    lecture: general ? { id: DEFAULT, title: "General Recordings", date, endDate: null } : { id: LECTURE, title: "Kinematics", date, endDate: null },
    class: CLASS,
    dashboard: { visible: true, visibleFrom: date, visibleUntil: date },
    streamUrl: `/api/student/recorded-lectures/x/stream`,
    resourceAccess: open,
    ...extra,
  } as RecordedLecture;
}

// ---- Helpers -----------------------------------------------------------------------------------------

test("list requests: section general / lecture with their own cursor; the section is optional (existing requests unchanged)", () => {
  assert.equal(listApiUrl({ classId: CLASS.id, section: "general" }, "CUR", 50), `/api/student/recorded-lectures?section=general&classId=${CLASS.id}&cursor=CUR&limit=50`);
  assert.equal(listApiUrl({ classId: CLASS.id, section: "lecture" }, null, 50), `/api/student/recorded-lectures?section=lecture&classId=${CLASS.id}&limit=50`);
  assert.equal(listApiUrl({ scope: "dashboard", section: "general" }, null, 6), "/api/student/recorded-lectures?scope=dashboard&section=general&limit=6");
  assert.equal(listApiUrl({ lectureId: LECTURE }, null, 50), `/api/student/recorded-lectures?lectureId=${LECTURE}&limit=50`, "the player's request: unchanged");
});

test("date labels: a General Recording's availability (the backend's date); a lecture's own date and time, unchanged", () => {
  const general = rec({ general: true, date: "2026-11-20T04:30:00.000Z" });
  const lecture = rec({ date: "2026-11-22T03:30:00.000Z" });
  assert.equal(recordingDateLabel(general), "Available 20 Nov 2026, 10:00 am");
  assert.equal(recordingDateLabel(lecture), "22 Nov 2026, 9:00 am");
  assert.equal(isGeneralRecording(general), true);
  assert.equal(isGeneralRecording(lecture), false);
  assert.equal(isGeneralRecording({ isGeneral: undefined } as unknown as RecordedLecture), false, "an older response without the flag: a lecture");
});

test("dashboard merge: newest first by each one's own date; recent General Recordings are never pushed out; the limit and no duplicates", () => {
  const g1 = rec({ general: true, date: "2026-11-23T10:00:00.000Z" });
  const g2 = rec({ general: true, date: "2026-11-18T10:00:00.000Z" });
  const l1 = rec({ date: "2026-11-22T03:30:00.000Z" });
  const l2 = rec({ date: "2026-11-21T03:30:00.000Z", part: 2 });
  const l3 = rec({ date: "2026-11-20T03:30:00.000Z", part: 3 });
  assert.deepEqual(mergeDashboardRecordings([g1, g2], [l1, l2, l3], 6).map((r) => r.id), [g1, l1, l2, l3, g2].map((r) => r.id));
  assert.deepEqual(mergeDashboardRecordings([g1, g2], [l1, l2, l3], 2).map((r) => r.id), [g1, l1].map((r) => r.id), "the limit keeps the newest of both");
  // Many lecture recordings no longer hide a recent General Recording (the old single list ordered by lecture date).
  const manyLectures = Array.from({ length: 6 }, (_, i) => rec({ date: `2026-11-1${i}T03:30:00.000Z`, part: i + 1 }));
  assert.equal(mergeDashboardRecordings([g1], manyLectures, 6)[0].id, g1.id);
  const sameTime = rec({ general: true, date: l1.lecture.date });
  assert.equal(mergeDashboardRecordings([sameTime], [l1], 6)[0].id, l1.id, "equal dates: lectures first (stable)");
  assert.deepEqual(mergeDashboardRecordings([g1], [g1], 6).map((r) => r.id), [g1.id], "no duplicates");
  assert.deepEqual(mergeDashboardRecordings([], [], 6), []);
});

// ---- The class page ----------------------------------------------------------------------------------

test("class page: General Recordings first, then Lecture Recordings; General parts with their availability, never the class's creation date", () => {
  // The API's order for the class page: part number ascending (a later upload can be an earlier part).
  const general = [rec({ general: true, part: 1, date: "2026-11-23T10:00:00.000Z" }), rec({ general: true, part: 2, date: "2026-11-20T04:30:00.000Z" })];
  const lectures = [rec({ part: 1 }), rec({ part: 2 })];
  const html = renderToStaticMarkup(
    <ClassRecordingsClient classInfo={CLASS} initialGeneral={{ recordedLectures: general, nextCursor: null }} initialRecordings={lectures} initialNextCursor={null} />
  );
  assert.ok(html.indexOf('data-recordings-section="general"') < html.indexOf('data-recordings-section="lecture"'), "General first");
  assert.match(text(html), /General Recordings Part 1 · General \d+ 10:00 · Available 23 Nov 2026, 3:30 pm Part 2 · General \d+ 10:00 · Available 20 Nov 2026, 10:00 am/, "rendered in the API's part order, each with its availability date");
  assert.match(text(html), /Watch general recordings/);
  assert.match(html, new RegExp(`href="/student/recorded-lectures/${DEFAULT}"`));
  assert.doesNotMatch(text(html), /5 Jan 2026|General Notes/, "never the default lecture's date or internal title");
  // The lecture section: titles, dates and parts exactly as before.
  assert.match(text(html), /Lecture Recordings Kinematics 22 Nov 2026, 9:00 am Part 1 · Kinematics part \d+ 10:00 Part 2 · Kinematics part \d+ 10:00 Watch lecture/);
});

test("class page: a clear empty state for General Recordings; the lecture section's own empty state unchanged", () => {
  const html = renderToStaticMarkup(<ClassRecordingsClient classInfo={CLASS} initialGeneral={{ recordedLectures: [], nextCursor: null }} initialRecordings={[]} initialNextCursor={null} />);
  assert.match(html, /data-recordings-empty="general"/);
  assert.match(text(html), /No general recordings for Physics yet\./);
  assert.match(text(html), /No recorded lectures yet/);
  const noProp = renderToStaticMarkup(<ClassRecordingsClient classInfo={CLASS} initialRecordings={[rec()]} initialNextCursor={null} />);
  assert.match(noProp, /data-recordings-empty="general"/, "without General data the section is simply empty");
});

test("class page: a locked General Recording shows the lock badge and no player link", () => {
  const locked = rec({ general: true, resourceAccess: { locked: true, year: 2026, month: 11 }, streamUrl: null });
  const html = renderToStaticMarkup(<ClassRecordingsClient classInfo={CLASS} initialGeneral={{ recordedLectures: [locked], nextCursor: null }} initialRecordings={[]} initialNextCursor={null} />);
  assert.match(html, /data-locked-resource="2026-11"/);
  assert.doesNotMatch(html, new RegExp(`recording=${locked.id}`));
});

test("class page: each section pages with its OWN section and cursor; Load more per section; requests aborted when the page leaves", () => {
  const html = renderToStaticMarkup(
    <ClassRecordingsClient classInfo={CLASS} initialGeneral={{ recordedLectures: [rec({ general: true })], nextCursor: "G1" }} initialRecordings={[rec()]} initialNextCursor="L1" />
  );
  assert.match(text(html), /Load more general recordings/);
  assert.match(text(html), /Load more recordings/);
  const client = code(source("components", "student-portal", "recorded-lectures", "class-recordings-client.tsx"));
  assert.match(client, /const general = useSectionPages\(classInfo\.id, "general", initialGeneral \?\? \{ recordedLectures: \[\], nextCursor: null \}\);/);
  assert.match(client, /const lectures = useSectionPages\(classInfo\.id, "lecture", \{ recordedLectures: initialRecordings, nextCursor: initialNextCursor \}\);/);
  assert.match(client, /fetch\(listApiUrl\(\{ classId, section \}, cursor, PAGE_SIZE\), \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(client, /useEffect\(\(\) => \(\) => controllerRef\.current\?\.abort\(\), \[\]\);/);
  assert.match(client, /if \(controller\.signal\.aborted\) return;/);
  // Switching class: the page renders a fresh client per class.
  const page = source("app", "student", "recorded-lectures", "page.tsx");
  assert.match(page, /<ClassRecordingsClient\s+[^>]*key=\{page\.class\.id\}/);
  assert.match(page, /initialGeneral=\{page\.general\}/);
});

// ---- The player --------------------------------------------------------------------------------------

test("player: a General Recording's header is 'General Recordings' without a date; a normal lecture keeps its title and date", () => {
  const generalParts = [rec({ general: true, part: 1 }), rec({ general: true, part: 2 })];
  const general = renderToStaticMarkup(
    <RecordingPlayer studentId="S1" lecture={generalParts[0].lecture} isGeneral classInfo={CLASS} initialParts={generalParts} initialNextCursor={null} requestedRecordingId={null} />
  );
  const header = general.slice(general.indexOf("<header"), general.indexOf("</header>"));
  assert.match(text(header), /^General Recordings Part 1 of 2$/);
  assert.doesNotMatch(text(header), /Nov 2026/, "no lecture date");

  const lectureParts = [rec({ part: 1 }), rec({ part: 2 })];
  const normal = renderToStaticMarkup(
    <RecordingPlayer studentId="S1" lecture={lectureParts[0].lecture} classInfo={CLASS} initialParts={lectureParts} initialNextCursor={null} requestedRecordingId={null} />
  );
  const normalHeader = normal.slice(normal.indexOf("<header"), normal.indexOf("</header>"));
  assert.match(text(normalHeader), /^Kinematics 22 Nov 2026, 9:00 am Part 1 of 2$/);
  assert.match(normal, new RegExp(`href="/student/recorded-lectures\\?classId=${CLASS.id}"`), "back to the class's recordings");
});

test("player page: passes isGeneral from the loader; playback stays the existing stream route (no second implementation)", () => {
  const page = source("app", "student", "recorded-lectures", "[lectureId]", "page.tsx");
  assert.match(page, /isGeneral=\{page\.isGeneral\}/);
  assert.match(page, /const playable = page\.parts\.filter\(\(part\) => !part\.resourceAccess\?\.locked\);/, "locked parts never reach the player");
  const player = code(source("components", "student-portal", "recorded-lectures", "recording-player.tsx"));
  assert.doesNotMatch(player, /\/api\/student\/recorded-lectures\/\$\{/, "the stream URL is the API's own streamUrl");
});

// ---- Dashboard widget --------------------------------------------------------------------------------

test("dashboard widget: both sections requested, merged by date, General labelled; requests aborted on unmount", () => {
  const widget = code(source("components", "student-portal", "recorded-lectures", "dashboard-recorded-lectures.tsx"));
  assert.match(widget, /setItems\(mergeDashboardRecordings\(general\.data\?\.recordedLectures \?\? \[\], lectures\.data\?\.recordedLectures \?\? \[\], WIDGET_LIMIT\)\);/);
  assert.match(widget, /\{isGeneralRecording\(item\) \? "General Recordings" : item\.lecture\.title\} · \{partLabel\(item\)\}/);
  assert.match(widget, /\{item\.class\.name\} · \{recordingDateLabel\(item\)\}/);
  assert.match(widget, /const controller = new AbortController\(\);\s*void load\(controller\.signal\);\s*return \(\) => controller\.abort\(\);/);
  assert.match(widget, /href=\{playerHref\(item\.lecture\.id, item\.id\)\}/, "links unchanged");
});

// ---- Public pages ----------------------------------------------------------------------------------------

test("public pages never list General Recordings (one shared rule; tests/recorded-lectures/student-general-recordings.test.cjs)", () => {
  assert.match(source("services", "recorded-lecture-public-service.ts"), /lecture: \{ status: 0, isDefault: false \}/);
});
