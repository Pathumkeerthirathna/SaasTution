/**
 * General Assignments / General Quizzes display (Stage 4): the views show the
 * label their DTO sends (lib/coursework-lecture.ts: "General Assignments" /
 * "General Quizzes" for the class's default lecture) and never a lecture date
 * for General content. The views load their own data (no DOM library here),
 * so their rendering is pinned at the source; the DTOs themselves:
 * tests/coursework/general-coursework-display.test.cjs.
 *
 *   npm run test:ui   (also npm run test:coursework)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { COURSEWORK_TEXT } from "../../components/coursework/class-coursework-workspace";
import { GENERAL_ASSIGNMENTS_LABEL, GENERAL_QUIZZES_LABEL } from "../../lib/coursework-lecture";

const ROOT = path.join(__dirname, "..", "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const VIEWS = {
  studentAssignments: ["app", "student", "assignments", "page.tsx"],
  studentQuizzes: ["app", "student", "quizzes", "page.tsx"],
  profileQuizzes: ["app", "student", "Components", "StudentQuizzes.tsx"],
  agenda: ["components", "student-portal", "dashboard-agenda.tsx"],
  teacherCoursework: ["components", "dashboard", "dashboard-coursework.tsx"],
  guardian: ["components", "guardian", "GuardianPortal.tsx"],
} as const;

test("student Assignments and Quizzes pages: the DTO's label; the lecture date only for a normal lecture (never for General content)", () => {
  for (const [name, item] of [["studentAssignments", "item"], ["studentQuizzes", "quiz"]] as const) {
    const page = source(...VIEWS[name]);
    assert.match(page, /  lectureDate: string \| null;\n  isGeneral\?: boolean;/, name);
    assert.match(page, new RegExp(`\\{${item}\\.lectureTitle\\}`), `${name}: the label / title as sent`);
    assert.match(
      page,
      new RegExp(`\\{!${item}\\.isGeneral && ${item}\\.lectureDate \\? \\(\\s*<span className="inline-flex items-center gap-1">\\s*<CalendarDays size=\\{11\\} />\\s*\\{fmtSriLankaDate\\(${item}\\.lectureDate\\)\\}\\s*</span>\\s*\\) : null\\}`),
      `${name}: no lecture date for General content`
    );
    assert.equal((page.match(/fmtSriLankaDate\((item|quiz)\.lectureDate\)/g) ?? []).length, 1, `${name}: the lecture date is shown in one place only`);
  }
});

test("student profile quiz results (teacher view): the label as sent; a General Quiz opens its class's General Quizzes, never a lecture that does not exist", () => {
  const view = source(...VIEWS.profileQuizzes);
  assert.match(view, /\{quiz\.lectureTitle\}/);
  assert.match(view, /href=\{quiz\.isGeneral \? `\/dashboard\/quizzes\?classId=\$\{encodeURIComponent\(cls\.classId\)\}` : `\/dashboard\/lectures\?focusLectureId=\$\{quiz\.lectureId\}`\}/);
  assert.match(view, /  lectureDate: string \| null;\n  isGeneral\?: boolean;/);
});

test("dashboards: the agenda and the teacher's coursework cards show the DTO's label (General Assignments for General content)", () => {
  assert.match(source(...VIEWS.agenda), /\{a\.className\} · \{a\.lectureTitle\}/);
  assert.match(source(...VIEWS.teacherCoursework), /\{a\.className\} &middot; \{a\.lectureTitle\}/);
  for (const view of [VIEWS.agenda, VIEWS.teacherCoursework]) {
    assert.match(source(...view), /\/\*\* The lecture's title, or "General Assignments" for a General Assignment \(isGeneral\)\. \*\/\n  lectureTitle: string;\n  isGeneral\?: boolean;/);
  }
});

test("no view identifies General content by its title, nor shows the internal title", () => {
  for (const [name, parts] of Object.entries(VIEWS)) {
    assert.doesNotMatch(source(...parts), /General Notes/, name);
  }
  // The guardian portal shows no lecture title or date for assignments / quizzes at all (its API is covered by the DTO test).
  assert.doesNotMatch(source(...VIEWS.guardian), /lectureTitle|lectureDate/);
});

test("one source for the labels: the pages, the class APIs and the DTOs share lib/coursework-lecture.ts", () => {
  assert.equal(GENERAL_ASSIGNMENTS_LABEL, "General Assignments");
  assert.equal(GENERAL_QUIZZES_LABEL, "General Quizzes");
  assert.equal(COURSEWORK_TEXT.assignments.general, GENERAL_ASSIGNMENTS_LABEL);
  assert.equal(COURSEWORK_TEXT.quizzes.general, GENERAL_QUIZZES_LABEL);
  assert.match(source("services", "class-assignments-service.ts"), /export \{ GENERAL_ASSIGNMENTS_LABEL \};/);
  assert.match(source("services", "class-quizzes-service.ts"), /export \{ GENERAL_QUIZZES_LABEL \};/);
  const dtos = [
    ["app", "api", "students", "me", "assignments", "route.ts"],
    ["app", "api", "students", "me", "quizzes", "route.ts"],
    ["app", "api", "student", "quizzes", "route.ts"],
    ["app", "api", "student", "dashboard", "assignments-due", "route.ts"],
    ["services", "dashboard-coursework-service.ts"],
    ["services", "guardian-portal-service.ts"],
    ["services", "student-service.ts"],
  ];
  for (const parts of dtos) {
    const src = source(...parts);
    assert.match(src, /\.\.\.coursework(LectureJson|LectureView|LectureLabel)\("(assignment|quiz)", (a|q|quiz)\.lecture\),/, parts.join("/"));
    assert.doesNotMatch(src, /lectureTitle: (a|q|quiz)\.lecture\.title/, `${parts.join("/")}: no raw lecture title`);
  }
});
