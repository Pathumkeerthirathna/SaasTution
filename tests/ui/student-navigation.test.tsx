/**
 * Student portal navigation reorganization:
 *  - sidebar: Dashboard, Calendar, My Classes, then Notes, Recordings (Recorded
 *    Lectures, Live Recordings, YouTube Live Sessions), Assignments
 *    (Assignments, Quizzes), Papers, Payments, Tutes / Papers, Lecture /
 *    Schedules, Attendance / History, Settings; no Messages, Teacher Profile
 *    or My Profile items;
 *  - header: Messages through the existing message bell ("View all" opens
 *    /student/messages); Teacher Profile and My Profile in the existing
 *    profile menu;
 *  - the two new read-only pages (Live Recordings, YouTube Live Sessions).
 * No DOM library: react-dom/server renders, helpers and source checks. The
 * APIs: tests/students/student-youtube-pages.test.cjs.
 *
 *   npm run test:ui
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { studentActiveNavHref, studentNavHrefs, studentNavItems, studentProfileMenuLinks } from "../../components/student-portal/student-data";
import { StudentSidebar } from "../../components/student-portal/student-sidebar";
import {
  firstStudentYouTubeClass,
  safeYouTubeLink,
  StudentYouTubeClient,
  studentYouTubeErrorMessage,
  studentYouTubeUrl,
} from "../../components/student-portal/recordings/student-youtube-client";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ---- The sidebar -----------------------------------------------------------------------------------

test("sidebar: the exact order, the two groups and their pages; no Messages, Teacher Profile or My Profile", () => {
  assert.deepEqual(
    studentNavItems.map((item) => item.label),
    ["Dashboard", "Calendar", "My Classes", "Notes", "Recordings", "Assignments", "Papers", "Payments", "Tutes / Papers", "Lecture / Schedules", "Attendance / History", "Settings"]
  );
  const recordings = studentNavItems.find((item) => item.label === "Recordings")!;
  assert.deepEqual(recordings.children, [
    { href: "/student/recorded-lectures", label: "Recorded Lectures" },
    { href: "/student/recordings/live-recordings", label: "Live Recordings" },
    { href: "/student/recordings/youtube-live-sessions", label: "YouTube Live Sessions" },
  ]);
  assert.equal(recordings.href, "/student/recorded-lectures", "the group's own address is its first page");
  const assignments = studentNavItems.find((item) => item.label === "Assignments")!;
  assert.deepEqual(assignments.children, [
    { href: "/student/assignments", label: "Assignments" },
    { href: "/student/quizzes", label: "Quizzes" },
  ]);
  const hrefs = studentNavHrefs();
  for (const removed of ["/student/messages", "/student/teacher-profile", "/student/profile"]) assert.ok(!hrefs.includes(removed), removed);
  // Each top-level item keeps its icon key (unchanged icons for the existing pages).
  assert.deepEqual(
    studentNavItems.map((item) => item.icon),
    ["dashboard", "calendar", "classes", "notes", "recordedLectures", "assignments", "papers", "payments", "folder", "lectures", "attendance", "settings"]
  );
});

test("every page the sidebar and the header menu link to exists (no route removed)", () => {
  const routes = [...studentNavHrefs(), ...studentProfileMenuLinks.map((l) => l.href), "/student/messages"];
  for (const href of routes) {
    assert.ok(existsSync(path.join(ROOT, "app", ...href.split("/").filter(Boolean), "page.tsx")), href);
  }
});

test("active highlighting: exact page, pages under a sidebar page, Settings / account security; header pages highlight nothing", () => {
  assert.equal(studentActiveNavHref("/student/quizzes"), "/student/quizzes");
  assert.equal(studentActiveNavHref("/student/recordings/live-recordings"), "/student/recordings/live-recordings");
  assert.equal(studentActiveNavHref("/student/recorded-lectures/L1"), "/student/recorded-lectures", "the recording player");
  assert.equal(studentActiveNavHref("/account/security"), "/student/settings");
  assert.equal(studentActiveNavHref("/student/settings/devices"), "/student/settings");
  for (const header of ["/student/profile", "/student/teacher-profile", "/student/messages"]) assert.equal(studentActiveNavHref(header), null, header);
  assert.equal(studentActiveNavHref("/student/unknown"), "/student/dashboard", "as before for any other path");
  assert.equal(studentActiveNavHref(null), "/student/dashboard");
});

function sidebar(activePath: string | null, open = true) {
  return renderToStaticMarkup(<StudentSidebar items={studentNavItems} activePath={activePath} open={open} onClose={() => {}} onToggle={() => {}} />);
}

test("sidebar render (open): the group holding the current page is expanded with that page marked; the other group is collapsed", () => {
  const html = sidebar("/student/quizzes");
  assert.match(html, /<a aria-current="page"[^>]*href="\/student\/quizzes">Quizzes<\/a>/);
  assert.match(html, /href="\/student\/assignments">Assignments<\/a>/);
  assert.doesNotMatch(html, /href="\/student\/recordings\/live-recordings"/, "Recordings stays collapsed");
  assert.match(html, /data-student-nav-group="Assignments"><button type="button" aria-expanded="true" class="[^"]*bg-white\/15/);
  assert.match(html, /data-student-nav-group="Recordings"><button type="button" aria-expanded="false" class="[^"]*text-white\/75/);
  const live = sidebar("/student/recordings/youtube-live-sessions");
  assert.match(live, /<a aria-current="page"[^>]*href="\/student\/recordings\/youtube-live-sessions">YouTube Live Sessions<\/a>/);
  // A plain item keeps its link and highlighting.
  assert.match(sidebar("/student/notes"), /aria-label="Notes" class="[^"]*bg-white\/15[^"]*" href="\/student\/notes"/);
  assert.doesNotMatch(sidebar(null), /bg-white\/15 font-medium/, "a header page highlights nothing");
});

test("sidebar render (collapsed rail): each group is one icon linking to its first page", () => {
  const html = sidebar("/student/quizzes", false);
  assert.match(html, /<a title="Assignments" aria-label="Assignments" class="[^"]*bg-white\/15[^"]*" data-student-nav-group="Assignments" href="\/student\/assignments">/);
  assert.match(html, /<a title="Recordings" aria-label="Recordings" class="[^"]*text-white\/75[^"]*" data-student-nav-group="Recordings" href="\/student\/recorded-lectures">/);
  assert.doesNotMatch(html, /href="\/student\/quizzes"/);
});

// ---- The header ------------------------------------------------------------------------------------

test("header: Messages stays reachable through the existing message bell; the profile menu links Teacher Profile and My Profile (one menu)", () => {
  assert.deepEqual(studentProfileMenuLinks, [
    { href: "/student/teacher-profile", label: "Teacher Profile", icon: "teacherProfile" },
    { href: "/student/profile", label: "My Profile", icon: "profile" },
  ]);
  const bell = source("components", "student-portal", "student-message-bell.tsx");
  assert.match(bell, /href="\/student\/messages"/, "the bell's 'View all' opens the Messages page");
  const shell = source("components", "student-portal", "student-shell.tsx");
  assert.match(shell, /<StudentMessageBell \/>/);
  const menu = shell.slice(shell.indexOf("{isProfileOpen && ("), shell.indexOf("</header>"));
  assert.match(menu, /\{studentName\}/);
  assert.match(menu, /\{studentEmail && /);
  assert.match(menu, /\{registrationNumber && \(/);
  const links = menu.indexOf("{studentProfileMenuLinks.map((link) => {");
  const logout = menu.indexOf("onClick={handleSignOut}");
  assert.ok(links > 0 && links < logout, "the page links, then Logout");
  assert.match(menu, /const Icon = link\.icon === "teacherProfile" \? Presentation : UserRound;/);
  assert.match(menu, /onClick=\{\(\) => setIsProfileOpen\(false\)\}/);
  assert.equal((shell.match(/\{isProfileOpen && \(/g) ?? []).length, 1, "a single profile menu");
  assert.match(shell, /const activePath = useMemo\(\(\) => studentActiveNavHref\(pathname\), \[pathname\]\);/);
  // The teacher panel is not changed by this stage.
  assert.doesNotMatch(source("components", "dashboard-shell.tsx"), /\/student\//);
});

// ---- The two new pages -------------------------------------------------------------------------------

test("new pages: read-only, one shared component, the student's classes from the server; YouTube embed for playback", () => {
  for (const [folder, kind] of [["live-recordings", "recordings"], ["youtube-live-sessions", "lives"]]) {
    assert.match(source("app", "student", "recordings", folder, "page.tsx"), new RegExp(`<StudentYouTubePage kind="${kind}" searchParams=\\{searchParams\\} />`));
  }
  const page = source("components", "student-portal", "recordings", "student-youtube-page.tsx");
  assert.match(page, /where: \{ studentId: session\.studentId, isActive: true, class: \{ status: 0 \} \}/);
  const client = source("components", "student-portal", "recordings", "student-youtube-client.tsx");
  assert.doesNotMatch(client, /method: "(POST|PUT|PATCH|DELETE)"/, "no write request of any kind");
  assert.doesNotMatch(client, /\/api\/(lectures|classes)\/|isDefault/, "no teacher API; never a default lecture");
  assert.match(client, /<YouTubeEmbedModal video=\{playing\} onClose=\{\(\) => setPlaying\(null\)\} title=\{text\.player\} \/>/);
  assert.match(client, /function chooseClass\(next: string\) \{\s*setClassId\(next\);\s*setLectureId\(""\);\s*setPage\(1\);/, "changing the class resets the lecture");
  assert.match(client, /fetch\(studentLecturesUrl\(classId, 1\), \{ cache: "no-store", signal: controller\.signal \}\)/, "the existing student lecture list");
  assert.match(client, /if \(controller\.signal\.aborted\) return;/);
});

test("new pages: URLs, the first class, outbound links and error messages", () => {
  const C = "11111111-1111-4111-8111-111111111111";
  assert.equal(studentYouTubeUrl("recordings", C, null, 1), `/api/student/classes/${C}/youtube-recordings?page=1&pageSize=20`);
  assert.equal(studentYouTubeUrl("lives", C, "L1", 2), `/api/student/classes/${C}/youtube-lives?page=2&pageSize=20&lectureId=L1`);
  assert.equal(firstStudentYouTubeClass([{ id: "a", name: "A" }]), "a");
  assert.equal(firstStudentYouTubeClass([{ id: "a", name: "A" }, { id: "b", name: "B" }]), "");
  assert.equal(firstStudentYouTubeClass([{ id: "a", name: "A" }, { id: "b", name: "B" }], "b"), "b");
  assert.equal(firstStudentYouTubeClass([{ id: "a", name: "A" }], "x"), "a", "an unknown class from the address is ignored");
  assert.equal(safeYouTubeLink("https://www.youtube.com/watch?v=abc"), "https://www.youtube.com/watch?v=abc");
  assert.equal(safeYouTubeLink("https://youtu.be/abc"), "https://youtu.be/abc");
  for (const bad of ["javascript:alert(1)", "http://www.youtube.com/watch?v=a", "https://evil.example/https://www.youtube.com/", null]) assert.equal(safeYouTubeLink(bad), null, String(bad));
  assert.equal(studentYouTubeErrorMessage(403, "Your access is paused.", "recordings"), "Your access is paused.");
  assert.equal(studentYouTubeErrorMessage(404, null, "recordings"), "This class or lecture is no longer available.");
  assert.equal(studentYouTubeErrorMessage(401, null, "live sessions"), "Your session has ended. Please sign in again.");
});

test("new pages render: no classes, a class to choose, and the loading state of the only class", () => {
  assert.match(renderToStaticMarkup(<StudentYouTubeClient kind="recordings" classes={[]} />), /data-student-youtube-empty="classes"/);
  const choose = renderToStaticMarkup(<StudentYouTubeClient kind="lives" classes={[{ id: "a", name: "Physics" }, { id: "b", name: "Chemistry" }]} />);
  assert.match(choose, /data-student-youtube-empty="no-class"/);
  assert.match(text(choose), /Select a class to see its live sessions\./);
  assert.match(choose, /disabled=""[^>]*data-student-youtube-lecture-select|data-student-youtube-lecture-select[^>]*disabled=""/);
  const only = renderToStaticMarkup(<StudentYouTubeClient kind="recordings" classes={[{ id: "a", name: "Physics" }]} />);
  assert.match(only, /<option value="a" selected="">Physics<\/option>/);
  assert.match(only, /<option value="" selected="">All lectures<\/option>/);
  assert.match(only, /data-student-youtube-state="loading"/);
  assert.match(text(only), /Loading recordings…/);
});
