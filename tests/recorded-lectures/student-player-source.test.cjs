/*
 * Recorded Lectures RL-5.1: source checks of the student pages and player
 * (the repository has no DOM renderer; behaviour that lives in the browser is
 * pinned here and verified for real in the pending real-browser phase).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const DIR = ["components", "student-portal", "recorded-lectures"];
const player = read(...DIR, "recording-player.tsx");
const classClient = read(...DIR, "class-recordings-client.tsx");
const widget = read(...DIR, "dashboard-recorded-lectures.tsx");
const resumeStore = read(...DIR, "resume-store.ts");
const listPage = read("app", "student", "recorded-lectures", "page.tsx");
const playerPage = read("app", "student", "recorded-lectures", "[lectureId]", "page.tsx");
const NEW_FILES = {
  "recording-player.tsx": player,
  "class-recordings-client.tsx": classClient,
  "dashboard-recorded-lectures.tsx": widget,
  "recording-helpers.ts": read(...DIR, "recording-helpers.ts"),
  "player-errors.ts": read(...DIR, "player-errors.ts"),
  "resume-store.ts": resumeStore,
  "page.tsx (list)": listPage,
  "page.tsx (player)": playerPage,
};

// ---- Video element and stream slots --------------------------------------------------------------

test("player: exactly one <video>, streaming the part's RL-4.3 streamUrl; no other media or preloading", () => {
  const code = stripComments(player);
  assert.equal((code.match(/<video\b/g) ?? []).length, 1);
  assert.match(code, /src=\{current\.streamUrl\}/);
  assert.match(code, /preload="metadata"/);
  assert.match(code, /playsInline/);
  assert.match(code, /controlsList="nodownload"/);
  assert.match(code, /\bcontrols\b/);
  assert.doesNotMatch(code, /<iframe|<audio|<source\b|new Audio|preload="auto"/);
  assert.doesNotMatch(code, /\.streamUrl\}[\s\S]*\.streamUrl\}/, "only the current part is ever a media source");
});

test("player: switching parts changes the src; leaving empties the element (download aborted, slot released)", () => {
  const code = stripComments(player);
  const release = code.slice(code.indexOf("function releaseMedia"));
  assert.match(release, /\.pause\(\)/);
  assert.match(release, /removeAttribute\("src"\)/);
  assert.match(release, /\.load\(\)/);
  assert.match(code, /return \(\) => \{[\s\S]*?releaseMedia\(video\)/, "the unmount cleanup releases the media");
  assert.match(code, /setCurrentId\(id\)/);
  // Server side of the same guarantee: student-stream.test.cjs "limits: a client disconnect frees the slot".
});

test("player: switching parts makes no server request (history.replaceState, not router.replace)", () => {
  const code = stripComments(player);
  assert.match(code, /window\.history\.replaceState\(/);
  assert.doesNotMatch(code, /useRouter|router\.(replace|push|refresh)/);
  const fetches = code.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 2, "only the HEAD diagnosis and 'Load more parts'");
});

test("player: a failure is diagnosed with ONE HEAD request (never an extra GET)", () => {
  const code = stripComments(player);
  assert.match(code, /fetch\(part\.streamUrl, \{ method: "HEAD"/);
  assert.equal((code.match(/fetch\([^)]*streamUrl/g) ?? []).length, 1);
  assert.match(code, /diagnosePlaybackFailure\(status\)/);
  assert.match(code, /if \(currentIdRef\.current !== id\) return;/, "a stale diagnosis after a part switch is ignored");
  assert.doesNotMatch(read(...DIR, "player-errors.ts").replace(/\/\*[\s\S]*?\*\//g, ""), /=== 429/, "429 is never expected from HEAD");
});

test("player: no automatic jump to the next part; a 'Play next part' button instead (D-5)", () => {
  const code = stripComments(player);
  assert.match(code, /Play next part/);
  const onEnded = code.slice(code.indexOf("function onEnded"), code.indexOf("async function onVideoError"));
  assert.doesNotMatch(onEnded, /selectPart|setCurrentId|\.play\(/);
  assert.doesNotMatch(code, /autoPlay|autoplay/);
});

test("player: speed, fullscreen (with the iOS fallback), keyboard and 'Load more parts'", () => {
  const code = stripComments(player);
  assert.match(code, /PLAYBACK_RATES\.map/);
  assert.match(code, /playbackRate = rateRef\.current/, "the speed is re-applied for each loaded part");
  assert.match(code, /requestFullscreen\(\)/);
  assert.match(code, /webkitEnterFullscreen\(\)/);
  assert.match(code, /exitFullscreen\(\)/);
  assert.match(code, /onKeyDown=\{onKeyDown\}/);
  assert.match(code, /Load more parts/);
  assert.match(code, /This lecture has more parts than are shown/);
});

// ---- Resume (per student, browser only) -----------------------------------------------------------

test("resume: localStorage is touched only in resume-store.ts, inside try; the player passes the student id", () => {
  for (const [name, src] of Object.entries(NEW_FILES)) {
    if (name === "resume-store.ts") continue;
    assert.doesNotMatch(stripComments(src), /localStorage|sessionStorage|indexedDB/, name);
  }
  const code = stripComments(resumeStore);
  assert.equal((code.match(/localStorage/g) ?? []).length, 1);
  assert.match(code, /try \{\s*if \(typeof window === "undefined"\) return null;\s*return window\.localStorage/);
  for (const call of ["saveResumePosition(browserStorage(), studentId", "readResumePosition(browserStorage(), studentId", "readLastPart(storage, studentId", "saveLastPart(browserStorage(), studentId"]) {
    assert.ok(player.includes(call), call);
  }
  assert.doesNotMatch(stripComments(player), /fetch\([^)]*(progress|position|resume)/i, "nothing is sent to the server");
});

test("resume: storage is read only after hydration (useEffect), never during the server render", () => {
  const code = stripComments(player);
  const initialState = code.slice(code.indexOf("const [currentId"), code.indexOf("const [rate"));
  assert.doesNotMatch(initialState, /browserStorage|readLastPart/);
});

// ---- Requests --------------------------------------------------------------------------------------

test("requests: pages load on the server through the loaders; links to the player never prefetch", () => {
  assert.doesNotMatch(listPage, /"use client"|fetch\(/);
  assert.doesNotMatch(playerPage, /"use client"|fetch\(/);
  assert.match(listPage, /loadClassRecordings\(session\.studentId, classId\)/);
  assert.match(listPage, /loadStudentRecordingClasses\(session\.studentId\)/);
  assert.match(playerPage, /loadLecturePlayer\(session\.studentId, params\.lectureId\)/);
  assert.match(playerPage, /notFound\(\)/);
  for (const [name, src] of [["class client", classClient], ["widget", widget]]) {
    const links = src.match(/<Link\b[\s\S]*?>/g) ?? [];
    const toPlayer = links.filter((l) => l.includes("playerHref("));
    assert.ok(toPlayer.length > 0, name);
    for (const link of toPlayer) assert.match(link, /prefetch=\{false\}/, `${name}: ${link.slice(0, 60)}`);
  }
  assert.match(widget, /listApiUrl\(\{ scope: "dashboard" \}, null, WIDGET_LIMIT\)/);
  assert.match(classClient, /listApiUrl\(\{ classId: classInfo\.id \}, nextCursor, PAGE_SIZE\)/);
});

test("client components never import server code", () => {
  for (const src of [player, classClient, widget]) {
    assert.match(src, /^"use client";/);
    assert.doesNotMatch(src, /@\/services\/|@\/lib\/prisma|@\/lib\/auth-session|server-only/);
  }
  // The shared helpers reach the server DTO module for its TYPE only (erased from the browser bundle).
  for (const name of ["recording-helpers.ts", "player-errors.ts", "resume-store.ts"]) {
    for (const [statement] of NEW_FILES[name].matchAll(/^import\b[^;]*;/gm)) {
      if (statement.includes("@/")) assert.match(statement, /^import type\b/, `${name}: ${statement}`);
    }
  }
});

// ---- Separation from YouTube recordings ------------------------------------------------------------

test("separation: no YouTube code in the recorded-lecture pages and components", () => {
  for (const [name, src] of Object.entries(NEW_FILES)) {
    assert.doesNotMatch(src, /youtube|videoId|lecture-list-client|<iframe/i, name);
  }
});

test("separation: lecture-list-client.tsx and the YouTube / lecture APIs are unchanged (git)", () => {
  const files = [
    "components/student-portal/lecture-list-client.tsx",
    "app/api/student/lectures",
    "app/api/lectures/[id]/recordings",
    "services/lecture-service.ts",
  ];
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...files], { cwd: root, encoding: "utf8" });
  assert.equal(diff.trim(), "", diff);
});

// ---- Responsive and accessible ---------------------------------------------------------------------

test("responsive: stacked on phones, side list on large screens; grids like the rest of the portal", () => {
  assert.match(player, /lg:grid-cols-\[minmax\(0,1fr\)_320px\]/);
  assert.match(player, /aspect-video w-full/);
  assert.match(classClient, /md:grid-cols-2 xl:grid-cols-3/);
  assert.match(listPage, /md:grid-cols-2 xl:grid-cols-3/);
  assert.match(widget, /sm:grid-cols-2/);
});

test("responsive: data is wrapped, never truncated or hidden at small widths", () => {
  for (const [name, src] of Object.entries(NEW_FILES)) {
    assert.doesNotMatch(src, /\btruncate\b|line-clamp|text-ellipsis|\bhidden sm:|\bhidden md:|\bhidden lg:/, name);
  }
  assert.match(player, /break-words/);
  assert.match(classClient, /break-words/);
});

test("accessible: every button is a 44 px touch target; icons are hidden from screen readers", () => {
  for (const [name, src] of [["player", player], ["class client", classClient]]) {
    // Up to each button's own className (an arrow function's ">" must not end the match).
    const buttons = [...src.matchAll(/<button\b[^<]*?className=(?:"([^"]*)"|\{`([^`]*)`\})/g)];
    assert.equal(buttons.length, (src.match(/<button\b/g) ?? []).length, `${name}: every button has a className`);
    assert.ok(buttons.length > 0, name);
    for (const [whole, plain, template] of buttons) {
      assert.match(plain ?? template, /min-h-\[44px\]/, `${name}: ${whole.replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
  assert.match(player, /role="alert"/);
  assert.match(player, /aria-label="Previous part"/);
  assert.match(player, /aria-label="Next part"/);
  assert.match(player, /aria-label="Playback speed"/);
});

// ---- Entry points (D-2) ------------------------------------------------------------------------------

test("entry points: sidebar item, My Classes link (active classes only) and the dashboard widget", () => {
  assert.match(read("components", "student-portal", "student-data.ts"), /href: "\/student\/recorded-lectures",\s+label: "Recorded Lectures",\s+icon: "recordedLectures"/);
  assert.match(read("components", "student-portal", "student-sidebar.tsx"), /recordedLectures: Video/);
  const classes = read("app", "student", "classes", "page.tsx");
  const at = classes.indexOf("/student/recorded-lectures?classId=");
  assert.ok(at > 0);
  const before = classes.slice(0, at);
  assert.ok(before.lastIndexOf("{!past ? (") > before.lastIndexOf("{past ? ("), "the link is in the active-class block only");
  const dashboard = read("app", "student", "dashboard", "page.tsx");
  assert.match(dashboard, /<DashboardRecordedLectures \/>/);
});
