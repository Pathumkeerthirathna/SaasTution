/**
 * The standalone teacher Assignments and Quizzes pages (Stage 3):
 *  - the pages, the sidebar "Assignments" group and the shared server-side
 *    selection (lib/teacher-class-lecture-selection.ts);
 *  - the workspace (components/coursework/class-coursework-workspace.tsx):
 *    class / optional lecture selection, General vs Lecture section, empty and
 *    loading states, the address kept in sync;
 *  - the panels' optional `scope` (LectureAssignmentPanel / LectureQuizPanel):
 *    list and create through /api/classes/[id]/assignments|quizzes, every
 *    per-item route through the lecture id that API returns; without a scope
 *    the panels are unchanged (lecture modal, live classroom).
 * No DOM library: react-dom/server renders, the pure URL helpers and source
 * checks. The APIs: tests/assignments/class-assignments.test.cjs,
 * tests/quizzes/class-quizzes.test.cjs.
 *
 *   npm run test:ui   (also npm run test:coursework-ui)
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
import { ClassCourseworkWorkspace, COURSEWORK_TEXT, courseworkSelectionQuery } from "../../components/coursework/class-coursework-workspace";
import { normalLectureLabel, normalLecturesUrl } from "../../components/class-selection/use-normal-lectures";
import { assignmentListUrl, LectureAssignmentPanel } from "../../components/lecture-assignment-panel";
import { LectureQuizPanel, quizListUrl } from "../../components/lecture-quiz-panel";
import { classContentUrl } from "../../lib/class-content-scope";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CLASSES = [
  { id: C1, name: "Physics" },
  { id: C2, name: "Chemistry" },
];

// ---- Pages and navigation ------------------------------------------------------------------------------

test("pages: one Assignments page and one Quizzes page; teacher session, server-checked selection, the shared workspace", () => {
  for (const [folder, kind] of [["assignments", "assignments"], ["quizzes", "quizzes"]]) {
    const page = code(source("app", "dashboard", folder, "page.tsx"));
    assert.match(page, /teacherId = \(await requireTeacherSession\(\)\)\.teacherId;/, folder);
    assert.match(page, /redirect\("\/dashboard"\);/, folder);
    assert.match(page, /const selection = await loadTeacherClassLectureSelection\(teacherId, searchParams\);/, folder);
    assert.match(
      page,
      new RegExp(`<ClassCourseworkWorkspace kind="${kind}" classes=\\{selection\\.classes\\} initialClassId=\\{selection\\.initialClassId\\} initialLectureId=\\{selection\\.initialLectureId\\} />`),
      folder
    );
  }
  // No separate General / Lecture pages.
  for (const extra of [["assignments", "general"], ["quizzes", "general"], ["assignments", "[lectureId]"], ["quizzes", "[lectureId]"]]) {
    assert.throws(() => source("app", "dashboard", ...extra, "page.tsx"), /ENOENT/, extra.join("/"));
  }
  // The YouTube pages use the same selection (a re-export, one implementation).
  assert.match(source("app", "dashboard", "recordings", "_lib", "youtube-lecture-selection.ts"), /loadTeacherClassLectureSelection as loadYouTubeLectureSelection/);
  assert.match(source("lib", "teacher-class-lecture-selection.ts"), /\.\.\.NORMAL_LECTURE_WHERE, class: \{ teacherId, status: 0 \}/);
});

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
const groupButton = (html: string) => {
  const at = html.indexOf(">Assignments<");
  return html.slice(html.lastIndexOf("<button", at), at);
};

test("sidebar: an Assignments group (Assignments, Quizzes) between Notes and Recordings; active on both pages only; locked for a pending teacher", () => {
  const shellSource = source("components", "dashboard-shell.tsx");
  assert.match(
    shellSource,
    /href: "\/dashboard\/assignments",\s+label: "Assignments",\s+icon: <ClipboardList size=\{18\} strokeWidth=\{1\.75\} \/>,\s+children: \[\s+\{ href: "\/dashboard\/assignments", label: "Assignments" \},\s+\{ href: "\/dashboard\/quizzes", label: "Quizzes" \},\s+\]/
  );
  const at = shellSource.indexOf('href: "/dashboard/assignments"');
  assert.ok(shellSource.indexOf('href: "/dashboard/notes"') < at && at < shellSource.indexOf('href: "/dashboard/recordings"'));
  for (const pathname of ["/dashboard/assignments", "/dashboard/quizzes"]) {
    const html = nav(shell(pathname));
    assert.match(groupButton(html), /bg-white\/15/, pathname);
  }
  for (const pathname of ["/dashboard", "/dashboard/notes", "/dashboard/lectures", "/dashboard/recordings/recorded-lectures"]) {
    assert.doesNotMatch(groupButton(nav(shell(pathname))), /bg-white\/15/, pathname);
  }
  const pending = nav(shell("/dashboard", true));
  assert.match(text(pending), /Assignments/);
  assert.doesNotMatch(pending, /href="\/dashboard\/(assignments|quizzes)"/);
});

// ---- The workspace ---------------------------------------------------------------------------------

test("workspace: no classes, and no class selected yet: an empty state and no panel (nothing is loaded)", () => {
  const none = renderToStaticMarkup(<ClassCourseworkWorkspace kind="assignments" classes={[]} />);
  assert.match(none, /data-coursework-empty="classes"/);
  assert.match(text(none), /You have no classes yet\./);
  const unselected = renderToStaticMarkup(<ClassCourseworkWorkspace kind="quizzes" classes={CLASSES} />);
  assert.match(unselected, /<h1 id="coursework-page-heading"[^>]*>Quizzes<\/h1>/);
  assert.match(text(unselected), /Select a class Physics Chemistry/);
  assert.match(unselected, /disabled=""[^>]*data-coursework-lecture-select|data-coursework-lecture-select[^>]*disabled=""/);
  assert.match(unselected, /data-coursework-empty="no-class"/);
  assert.match(text(unselected), /Select a class to manage its quizzes\./);
  assert.doesNotMatch(unselected, /data-coursework-section/);
});

test("workspace: a class without a lecture is the General section, managed by the existing panel in scope mode", () => {
  for (const kind of ["assignments", "quizzes"] as const) {
    const html = renderToStaticMarkup(<ClassCourseworkWorkspace kind={kind} classes={CLASSES} initialClassId={C2} />);
    assert.match(html, new RegExp(`<option value="${C2}" selected="">Chemistry</option>`), kind);
    assert.match(html, /data-coursework-section="GENERAL"/, kind);
    assert.match(html, new RegExp(`data-coursework-scope="${C2}:general"`), kind);
    assert.match(html, new RegExp(`<h2[^>]*>${COURSEWORK_TEXT[kind].general}</h2>`), kind);
    assert.match(html, new RegExp(`<option value="" selected="">${COURSEWORK_TEXT[kind].general} \\(no lecture\\)</option>`), kind);
    assert.match(html, /data-coursework-lectures="loading"/, "the lecture list is loading");
    // The existing panel renders inside (its own add / list controls).
    assert.match(text(html), kind === "assignments" ? /Add new assignment/ : /No quizzes added yet\./, kind);
  }
});

test("workspace: a lecture from the address is the LECTURE section until the list arrives; the panel is keyed by the selection", () => {
  const html = renderToStaticMarkup(<ClassCourseworkWorkspace kind="quizzes" classes={CLASSES} initialClassId={C1} initialLectureId={L1} />);
  assert.match(html, /data-coursework-section="LECTURE"/);
  assert.match(html, new RegExp(`data-coursework-scope="${C1}:${L1}"`));
  assert.match(html, new RegExp(`<option value="${L1}" selected="">Selected lecture</option>`));
  // A lecture without its class is ignored.
  const orphan = renderToStaticMarkup(<ClassCourseworkWorkspace kind="quizzes" classes={CLASSES} initialLectureId={L1} />);
  assert.doesNotMatch(orphan, /data-coursework-section/);

  const ws = code(source("components", "coursework", "class-coursework-workspace.tsx"));
  assert.match(ws, /<LectureAssignmentPanel key=\{scopeKey\} scope=\{\{ classId, lectureId: lectureId \|\| null \}\} \/>/);
  assert.match(ws, /<LectureQuizPanel key=\{scopeKey\} scope=\{\{ classId, lectureId: lectureId \|\| null \}\} \/>/);
  assert.match(ws, /const scopeKey = `\$\{classId\}:\$\{lectureId \|\| "general"\}`;/);
  assert.match(ws, /function chooseClass\(next: string\) \{\s*setClassId\(next\);\s*setLectureId\(""\);/, "switching the class clears the lecture (General of the new class)");
  assert.match(ws, /useNormalLectures\(classId \|\| null\)/);
  assert.match(ws, /window\.history\.replaceState\(window\.history\.state, "", next\)/, "the selection stays in the address");
  assert.doesNotMatch(ws, /isDefault|fetch\(/, "no request of its own; never a default lecture");
});

test("URLs: class routes with and without a lecture; the normal-lecture list; the page address", () => {
  assert.equal(classContentUrl("assignments", { classId: C1 }), `/api/classes/${C1}/assignments`);
  assert.equal(classContentUrl("assignments", { classId: C1, lectureId: null }), `/api/classes/${C1}/assignments`);
  assert.equal(classContentUrl("quizzes", { classId: C1, lectureId: L1 }), `/api/classes/${C1}/quizzes?lectureId=${L1}`);
  assert.equal(classContentUrl("quizzes", { classId: "a b", lectureId: "c&d" }), "/api/classes/a%20b/quizzes?lectureId=c%26d");
  assert.equal(normalLecturesUrl(C1, 2), `/api/lectures?classId=${C1}&page=2&pageSize=100&sortOrder=desc`);
  assert.equal(normalLectureLabel({ id: L1, title: "Kinematics", date: "2026-11-23T20:00:00.000Z" }), "Kinematics · 24 Nov 2026");
  assert.equal(courseworkSelectionQuery("", ""), "");
  assert.equal(courseworkSelectionQuery(C1, ""), `?classId=${C1}`);
  assert.equal(courseworkSelectionQuery(C1, L1), `?classId=${C1}&lectureId=${L1}`);
  assert.equal(courseworkSelectionQuery("", L1), "", "no lecture without its class");
  const hook = code(source("components", "class-selection", "use-normal-lectures.ts"));
  assert.match(hook, /fetch\(normalLecturesUrl\(classId, page\), \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(hook, /if \(controller\.signal\.aborted\) return;/);
  assert.match(hook, /return \(\) => controller\.abort\(\);/);
});

// ---- The panels' scope ---------------------------------------------------------------------------------

test("panels with a scope: list / create via the class route (General without lectureId); items via the lecture id it returned", () => {
  assert.equal(assignmentListUrl({ scope: { classId: C1 } }), `/api/classes/${C1}/assignments`);
  assert.equal(assignmentListUrl({ scope: { classId: C1, lectureId: L1 } }), `/api/classes/${C1}/assignments?lectureId=${L1}`);
  assert.equal(quizListUrl({ scope: { classId: C1 } }), `/api/classes/${C1}/quizzes`);
  assert.equal(quizListUrl({ scope: { classId: C1, lectureId: L1 } }), `/api/classes/${C1}/quizzes?lectureId=${L1}`);

  for (const [file, kind, item] of [
    ["lecture-assignment-panel.tsx", "assignments", "Assignment"],
    ["lecture-quiz-panel.tsx", "quizzes", "Quiz"],
  ] as const) {
    const panel = code(source("components", file));
    const listFn = kind === "assignments" ? "assignmentListUrl" : "quizListUrl";
    assert.match(panel, new RegExp(`const response = await fetch\\(${listFn}\\(props\\), \\{`), `${file}: list`);
    assert.match(panel, new RegExp(`: ${listFn}\\(props\\),`), `${file}: create`);
    assert.match(panel, /const itemLectureId = props\.scope \? scopeLectureId : props\.lectureId;/, file);
    assert.match(panel, new RegExp(`setScopeLectureId\\(scoped\\?\\.lecture\\.id \\?\\? null\\);`), file);
    assert.match(panel, new RegExp(`list = scoped\\?\\.${kind} \\?\\? \\[\\];`), file);
    // Every per-item route uses the resolved lecture; none uses the prop directly.
    assert.doesNotMatch(panel, new RegExp(`\\$\\{props\\.lectureId\\}/${kind}/`), `${file}: no item route on props.lectureId`);
    // Assignments: edit, delete, submissions, marks and the two file links; quizzes: edit, delete, results.
    assert.equal((panel.match(new RegExp(`/api/lectures/\\$\\{itemLectureId\\}/${kind}/`, "g")) ?? []).length, kind === "assignments" ? 6 : 3, file);
    // An older load never replaces a newer one.
    assert.match(panel, /const sequence = \+\+loadSequence\.current;/, file);
    assert.match(panel, /if \(sequence !== loadSequence\.current\) return;/, file);
    assert.match(panel, /\}, \[props\.lectureId, props\.scope\?\.classId, props\.scope\?\.lectureId\]\);/, file);
    assert.ok(item);
  }
});

test("panels without a scope are unchanged: the lecture's own routes; the lecture modal and live classroom pass only lectureId", () => {
  assert.equal(assignmentListUrl({ lectureId: L1 }), `/api/lectures/${L1}/assignments`);
  assert.equal(quizListUrl({ lectureId: L1 }), `/api/lectures/${L1}/quizzes`);
  const assignment = renderToStaticMarkup(<LectureAssignmentPanel lectureId={L1} />);
  assert.match(text(assignment), /Existing assignments Open a record to edit or inspect submissions\. 0 total/);
  assert.match(text(assignment), /Add new assignment No assignments added yet\./);
  const quiz = renderToStaticMarkup(<LectureQuizPanel lectureId={L1} />);
  assert.match(text(quiz), /No quizzes added yet\./);
  const scoped = renderToStaticMarkup(<LectureQuizPanel scope={{ classId: C1 }} />);
  assert.equal(scoped, quiz, "the same panel, the same markup: only the data source differs");

  const modal = code(source("components", "lecture-management-panel.tsx"));
  assert.match(modal, /<LectureQuizPanel lectureId=\{quizPanelLecture\.id\} onChanged=/);
  assert.match(modal, /<LectureAssignmentPanel\s+lectureId=/);
  const live = code(source("components", "Jitsi", "classroom", "sidebar", "RightSidebar.tsx"));
  assert.match(live, /<LectureAssignmentPanel lectureId=\{props\.lectureId\} \/>/);
  assert.match(live, /<LectureQuizPanel lectureId=\{props\.lectureId\} \/>/);
  assert.doesNotMatch(modal + live, /scope=\{/, "the existing places never use the class scope");
});

test("quiz results and the students' historical review are unchanged by this stage", () => {
  const panel = code(source("components", "lecture-quiz-panel.tsx"));
  assert.match(panel, /fetch\(`\/api\/lectures\/\$\{itemLectureId\}\/quizzes\/\$\{quizId\}\/results`, \{/, "results through the existing route");
  assert.match(panel, /resultsData\.submissions\.map\(\(sub\) =>/);
  assert.match(panel, /\{sub\.attemptCount\} attempt\{sub\.attemptCount === 1 \? "" : "s"\}/);
  // The student review renders the snapshot questions it receives (one per answered question, by id).
  const attempt = code(source("components", "student-portal", "quiz-attempt-action.tsx"));
  assert.match(attempt, /fetch\(`\/api\/student\/quizzes\/\$\{quizId\}\/review`, \{ cache: "no-store" \}\)/);
  assert.match(attempt, /reviewDetail\.quiz\.questions\.map\(\(question, index\) => \(/);
  assert.match(code(source("app", "api", "student", "quizzes", "[quizId]", "review", "route.ts")), /questions: reviewQuestionsFromAnswers\(submission\.answers\)/);
});
