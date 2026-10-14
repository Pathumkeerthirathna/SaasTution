/*
 * Regression tests: the classroom header and right sidebar share the teacher
 * workspace's navy background (#112D5C) for students too. Only the
 * background changes; the student's borders and hover tones are kept.
 *
 *   npm run test:jitsi
 *
 * Source-level checks of the Tailwind classes (no browser rendering).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = file => fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8");
const NAVY = "bg-[#112D5C]";
const OLD_GREEN = "bg-[#10231D]";

test("classroom header: the student branch uses the teacher navy, border kept", () => {
    const source = read("components/Jitsi/classroom/meeting/MeetingCard.tsx");
    const branch = /role === "student"\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/.exec(source);

    assert.ok(branch, "header role branch found");
    assert.ok(branch[1].includes(NAVY), "student header background");
    assert.ok(branch[1].includes("border-[#1C332B]"), "student header border unchanged");
    assert.ok(branch[2].includes(NAVY), "teacher header unchanged");
    assert.ok(!source.includes(OLD_GREEN));
});

test("right sidebar: the student chrome background is the teacher navy, the rest kept", () => {
    const source = read("components/Jitsi/classroom/sidebar/RightSidebar.tsx");
    const student = /const chrome = isStudent\s*\?\s*\{([\s\S]*?)\}\s*:\s*\{([\s\S]*?)\};/.exec(source);

    assert.ok(student, "chrome themes found");
    assert.match(student[1], /panelBg: "bg-\[#112D5C\]"/, "student rail / panel background");
    assert.match(student[1], /panelBorder: "border-\[#1C332B\]"/, "student border unchanged");
    assert.match(student[1], /closeHover: "hover:bg-\[#22392F\] hover:text-white"/, "student hover unchanged");
    assert.match(student[2], /panelBg: "bg-\[#112D5C\]"/, "teacher unchanged");
    assert.ok(!source.includes(OLD_GREEN));
});
