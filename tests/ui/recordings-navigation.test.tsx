/**
 * Recordings navigation consolidation: the teacher sidebar's Recordings group
 * (Recorded Lectures, YouTube Live Sessions, Live Recordings; Live Sessions
 * stays its own item), the routes and redirects, the shared YouTube panels
 * extracted from components/lecture-management-panel.tsx, the YouTube
 * workspace pages and the shared player modal. No DOM library:
 * react-dom/server renders, the pure helpers and source checks. The pages'
 * server-side class / lecture validation: tests/youtube/youtube-lecture-selection.test.cjs.
 *
 *   npm run test:ui   (also npm run test:recordings-ui)
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { DashboardShell } from "../../components/dashboard-shell";
import FormerRecordedLecturesPage from "../../app/dashboard/recorded-lectures/page";
import RecordingsIndexPage from "../../app/dashboard/recordings/page";
import { LectureLiveBroadcastsPanel, LIVE_PRIVACY_OPTIONS, lectureLivesUrl } from "../../components/youtube/lecture-live-broadcasts-panel";
import {
  LectureYouTubeRecordingsPanel,
  RECORDING_ACCESS_OPTIONS,
  RECORDING_VISIBILITY_OPTIONS,
  lectureRecordingsUrl,
} from "../../components/youtube/lecture-youtube-recordings-panel";
import { YouTubeEmbedModal, youtubeEmbedUrl, readYouTubeApiError } from "../../components/youtube/youtube-embed-modal";
import { YouTubeLectureWorkspace, YOUTUBE_WORKSPACE_TEXT, youtubeLectureLabel, youtubeLecturesUrl } from "../../components/youtube/youtube-lecture-workspace";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const router: AppRouterInstance = { back: () => {}, forward: () => {}, refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} };
function shell(pathname: string, isPending = false) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <DashboardShell role="TEACHER" name="Teacher" email="t@example.com" isPending={isPending}>
          <p>content</p>
        </DashboardShell>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}
const nav = (html: string) => html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));

const CLASSES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Physics" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Chemistry" },
];
const LECTURE = "33333333-3333-4333-8333-333333333333";

// ---- Sidebar -----------------------------------------------------------------------------------------

test("sidebar: one Recordings group with the three pages, after Notes; Live Sessions stays its own item; no flat Recorded Lectures", () => {
  const shellSource = source("components", "dashboard-shell.tsx");
  assert.match(
    shellSource,
    /href: "\/dashboard\/recordings",\s+label: "Recordings",\s+icon: <Video size=\{18\} strokeWidth=\{1\.75\} \/>,\s+children: \[\s+\{ href: "\/dashboard\/recordings\/recorded-lectures", label: "Recorded Lectures" \},\s+\{ href: "\/dashboard\/recordings\/youtube-live-sessions", label: "YouTube Live Sessions" \},\s+\{ href: "\/dashboard\/recordings\/live-recordings", label: "Live Recordings" \},\s+\]/
  );
  assert.ok(shellSource.indexOf('href: "/dashboard/notes"') < shellSource.indexOf('href: "/dashboard/recordings"'));
  assert.match(shellSource, /\{ href: "\/dashboard\/sessions",\s+label: "Live Sessions",/);
  assert.doesNotMatch(shellSource, /href: "\/dashboard\/recorded-lectures"/);

  const html = nav(shell("/dashboard"));
  assert.match(text(html), /Recordings/);
  assert.match(html, /aria-label="Live Sessions"[^>]*href="\/dashboard\/sessions"|href="\/dashboard\/sessions"[^>]*aria-label="Live Sessions"/);
});

test("sidebar: the Recordings group is active on each of its pages (and only there)", () => {
  const groupButton = (html: string) => {
    const at = html.indexOf(">Recordings<");
    return html.slice(html.lastIndexOf("<button", at), at);
  };
  for (const pathname of ["/dashboard/recordings/recorded-lectures", "/dashboard/recordings/youtube-live-sessions", "/dashboard/recordings/live-recordings"]) {
    assert.match(groupButton(nav(shell(pathname))), /bg-white\/15/, pathname);
  }
  for (const pathname of ["/dashboard", "/dashboard/sessions", "/dashboard/notes", "/dashboard/lectures"]) {
    assert.doesNotMatch(groupButton(nav(shell(pathname))), /bg-white\/15/, pathname);
  }
});

test("sidebar: a pending teacher sees Recordings locked (no link to any recordings page), like every other item", () => {
  const html = nav(shell("/dashboard", true));
  assert.match(text(html), /Recordings/);
  assert.doesNotMatch(html, /href="\/dashboard\/recordings/);
  assert.match(html, /role="link" aria-disabled="true"/);
});

// ---- Routes ------------------------------------------------------------------------------------------

function redirectTarget(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const digest = String((error as { digest?: string }).digest ?? "");
    const match = /^NEXT_REDIRECT;[^;]*;([^;]+);/.exec(digest);
    if (match) return match[1];
    throw error;
  }
  throw new Error("no redirect");
}

test("routes: the former /dashboard/recorded-lectures and /dashboard/recordings redirect to Recordings > Recorded Lectures", () => {
  assert.equal(redirectTarget(() => FormerRecordedLecturesPage()), "/dashboard/recordings/recorded-lectures");
  assert.equal(redirectTarget(() => RecordingsIndexPage()), "/dashboard/recordings/recorded-lectures");
});

test("routes: the new pages check the teacher session; the YouTube pages validate the class / lecture on the server", () => {
  const recorded = code(source("app", "dashboard", "recordings", "recorded-lectures", "page.tsx"));
  assert.match(recorded, /teacherId = \(await requireTeacherSession\(\)\)\.teacherId;/);
  assert.match(recorded, /<TeacherRecordingsWorkspace teacherId=\{teacherId\} \/>/);
  for (const [folder, kind] of [["youtube-live-sessions", "lives"], ["live-recordings", "recordings"]]) {
    const page = code(source("app", "dashboard", "recordings", folder, "page.tsx"));
    assert.match(page, /teacherId = \(await requireTeacherSession\(\)\)\.teacherId;/, folder);
    assert.match(page, /const selection = await loadYouTubeLectureSelection\(teacherId, searchParams\);/, folder);
    assert.match(page, new RegExp(`<YouTubeLectureWorkspace kind="${kind}" classes=\\{selection\\.classes\\} initialClassId=\\{selection\\.initialClassId\\} initialLectureId=\\{selection\\.initialLectureId\\} />`), folder);
  }
  // The lecture-specific recorded-lecture pages and studio are unchanged.
  assert.match(source("app", "dashboard", "lectures", "[lectureId]", "recordings", "page.tsx"), /<TeacherRecordingsClient teacherId=\{teacherId\} initial=\{initial\} \/>/);
});

// ---- The YouTube workspace pages ---------------------------------------------------------------------

test("workspace: headings per page; class selector from the server's list; nothing loaded before a class and a lecture are chosen", () => {
  const lives = renderToStaticMarkup(<YouTubeLectureWorkspace kind="lives" classes={CLASSES} />);
  assert.match(lives, /<h1 id="youtube-page-heading"[^>]*>YouTube Live Sessions<\/h1>/);
  assert.match(text(lives), /Select a class Physics Chemistry/);
  assert.match(lives, /data-youtube-lecture-select[^>]*>|disabled=""[^>]*data-youtube-lecture-select/);
  assert.doesNotMatch(lives, /data-youtube-panel=/);
  assert.match(text(lives), /Select a class and a lecture\./);
  const recordings = renderToStaticMarkup(<YouTubeLectureWorkspace kind="recordings" classes={CLASSES} />);
  assert.match(recordings, /<h1 id="youtube-page-heading"[^>]*>Live Recordings<\/h1>/);
  assert.equal(YOUTUBE_WORKSPACE_TEXT.recordings.empty, "Select a lecture to see its live recordings.");
  const none = renderToStaticMarkup(<YouTubeLectureWorkspace kind="lives" classes={[]} />);
  assert.match(none, /data-youtube-empty="classes"/);
});

test("workspace: a validated class / lecture from a link opens that lecture's panel at once (the right panel per page)", () => {
  const lives = renderToStaticMarkup(<YouTubeLectureWorkspace kind="lives" classes={CLASSES} initialClassId={CLASSES[1].id} initialLectureId={LECTURE} />);
  assert.match(lives, /<option value="22222222-2222-4222-8222-222222222222" selected="">Chemistry<\/option>/);
  assert.match(lives, new RegExp(`data-youtube-lecture="${LECTURE}"`));
  assert.match(lives, /data-youtube-panel="lives"/);
  assert.match(text(lives), /Live Streams Loading live streams\.\.\./);
  const recordings = renderToStaticMarkup(<YouTubeLectureWorkspace kind="recordings" classes={CLASSES} initialClassId={CLASSES[0].id} initialLectureId={LECTURE} />);
  assert.match(recordings, /data-youtube-panel="recordings"/);
  // A lecture without its class is ignored.
  const orphan = renderToStaticMarkup(<YouTubeLectureWorkspace kind="recordings" classes={CLASSES} initialLectureId={LECTURE} />);
  assert.doesNotMatch(orphan, /data-youtube-panel=/);
});

test("workspace: normal lectures from the existing lecture API (never a default lecture), per lecture only; stale responses dropped; class switch clears the lecture", () => {
  assert.equal(youtubeLecturesUrl(CLASSES[0].id, 2), `/api/lectures?classId=${CLASSES[0].id}&page=2&pageSize=100&sortOrder=desc`);
  assert.equal(youtubeLectureLabel({ id: LECTURE, title: "Kinematics", date: "2026-11-23T20:00:00.000Z" }), "Kinematics · 24 Nov 2026");
  const ws = code(source("components", "youtube", "youtube-lecture-workspace.tsx"));
  assert.match(ws, /fetch\(youtubeLecturesUrl\(classId, page\), \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(ws, /if \(controller\.signal\.aborted\) return;/);
  assert.match(ws, /return \(\) => controller\.abort\(\);/);
  assert.match(ws, /function chooseClass\(next: string\) \{\s*setClassId\(next\);\s*setLectureId\(""\);\s*setPage\(1\);/);
  assert.doesNotMatch(ws, /isDefault|\/api\/classes\//, "no class-wide request; the API excludes default lectures");
  assert.match(ws, /<LectureLiveBroadcastsPanel key=\{lectureId\} lectureId=\{lectureId\} \/>/);
  assert.match(ws, /<LectureYouTubeRecordingsPanel key=\{lectureId\} lectureId=\{lectureId\} \/>/);
});

// ---- The extracted panels and the player modal ---------------------------------------------------------------

test("panels: the existing per-lecture APIs and controls, unchanged (options, labels, empty / loading texts)", () => {
  assert.equal(lectureRecordingsUrl("L1"), "/api/lectures/L1/recordings");
  assert.equal(lectureLivesUrl("L1"), "/api/lectures/L1/lives");
  assert.deepEqual(RECORDING_VISIBILITY_OPTIONS, [{ value: "PUBLIC", label: "Public" }, { value: "PRIVATE", label: "Private" }]);
  assert.deepEqual(RECORDING_ACCESS_OPTIONS, [{ value: "FREE", label: "Free" }, { value: "LOCKED", label: "Locked" }]);
  assert.deepEqual(LIVE_PRIVACY_OPTIONS.map((o) => o.value), ["public", "unlisted", "private"]);
  assert.match(text(renderToStaticMarkup(<LectureYouTubeRecordingsPanel lectureId="L1" />)), /^Recordings Loading recordings\.\.\.$/);
  assert.match(text(renderToStaticMarkup(<LectureLiveBroadcastsPanel lectureId="L1" />)), /^Live Streams Loading live streams\.\.\.$/);
  const recordings = code(source("components", "youtube", "lecture-youtube-recordings-panel.tsx"));
  assert.match(recordings, /fetch\(`\/api\/lectures\/\$\{lectureId\}\/recordings\/\$\{recordingId\}`, \{\s*method: "PUT",/);
  assert.match(recordings, /toast\.success\("Recording updated successfully\."\)/);
  assert.match(recordings, /No recordings available for this lecture yet\./);
  const lives = code(source("components", "youtube", "lecture-live-broadcasts-panel.tsx"));
  assert.match(lives, /fetch\(`\/api\/lectures\/\$\{lectureId\}\/lives\/\$\{liveId\}\/privacy`, \{\s*method: "PUT",/);
  assert.match(lives, /privacy: privacy\.toUpperCase\(\)/);
  assert.match(lives, /reportSuccess\("Live stream privacy updated successfully\."\)/);
  assert.match(lives, /No YouTube live streams for this lecture yet\./);
  for (const panel of [recordings, lives]) {
    assert.match(panel, /const controller = new AbortController\(\);/);
    assert.match(panel, /<YouTubeEmbedModal video=\{playing\} onClose=\{\(\) => setPlaying\(null\)\} \/>/);
  }
});

test("player modal: the YouTube embed of the chosen video (as before); nothing when closed", () => {
  assert.equal(renderToStaticMarkup(<YouTubeEmbedModal video={null} onClose={() => {}} />), "");
  const html = renderToStaticMarkup(<YouTubeEmbedModal video={{ id: "R1", videoId: "abc123" }} onClose={() => {}} />);
  assert.match(html, /<iframe title="Lecture recording" src="https:\/\/www\.youtube\.com\/embed\/abc123\?autoplay=1"/);
  assert.match(html, /allowfullscreen=""/);
  assert.equal(youtubeEmbedUrl("x"), "https://www.youtube.com/embed/x?autoplay=1");
  assert.equal(readYouTubeApiError({ error: { message: "Nope" } }, "f"), "Nope");
  assert.equal(readYouTubeApiError(null, "f"), "f");
});

// ---- The lecture management panel (regression) ----------------------------------------------------------

test("lecture panel: both toggles kept; they render the shared panels inside the same card section; banners kept; no second implementation", () => {
  const panel = code(source("components", "lecture-management-panel.tsx"));
  assert.match(panel, /onClick=\{\(\) => toggleRecordings\(lecture\.id\)\}/);
  assert.match(panel, /onClick=\{\(\) => toggleLives\(lecture\.id\)\}/);
  assert.match(panel, /\{expandedRecordingIds\.has\(lecture\.id\) \? \(\s*<div className="mt-3 border-t border-slate-100 pt-3">\s*<LectureYouTubeRecordingsPanel lectureId=\{lecture\.id\} onError=\{setErrorMessage\} \/>/);
  assert.match(panel, /\{expandedLiveIds\.has\(lecture\.id\) \? \(\s*<div className="mt-3 border-t border-slate-100 pt-3">\s*<LectureLiveBroadcastsPanel lectureId=\{lecture\.id\} onError=\{setErrorMessage\} onSuccess=\{setSuccessMessage\} \/>/);
  // The other lecture-card sections are untouched (sessions, tabs, recorded lectures link).
  assert.match(panel, /\{expandedSessionIds\.has\(lecture\.id\) \? \(/);
  assert.match(panel, /href=\{`\/dashboard\/lectures\/\$\{encodeURIComponent\(lecture\.id\)\}\/recordings`\}/);
  // Exactly one implementation of each request in the codebase's components.
  for (const [needle, owner] of [
    ["/recordings/${recordingId}`", "lecture-youtube-recordings-panel.tsx"],
    ["lectureRecordingsUrl(lectureId)", "lecture-youtube-recordings-panel.tsx"],
    ["lectureLivesUrl(lectureId)", "lecture-live-broadcasts-panel.tsx"],
    ["/lives/${liveId}/privacy`", "lecture-live-broadcasts-panel.tsx"],
  ] as const) {
    assert.ok(!panel.includes(needle), `the lecture panel no longer has ${needle}`);
    assert.ok(source("components", "youtube", owner).includes(needle), owner);
  }
  // The classroom's YouTube start / stop workflow is untouched.
  assert.match(source("components", "Jitsi", "JitsiClassroom.tsx"), /\/api\/youtube\/lecture\/recording\/start/);
});
