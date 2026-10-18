/*
 * Regression tests: Jitsi's own filmstrip hidden for students only
 * (deploy/jitsi/custom.js, "Student Filmstrip Hide").
 *
 *   npm run test:jitsi
 *
 * - The page creates a student's iframe with config.filmstrip.disabled =
 *   true (a teacher's with false). Only then, and only while the local
 *   participant is not a moderator, <body> gets the class that hides
 *   .filmstrip (display: none !important, beating Jitsi's (0,3,1) rule).
 * - A teacher never gets it: not before the moderator role arrives, not
 *   after. A promoted student loses it.
 * - <body> is touched only when the answer changes (other blocks observe its
 *   class attribute); the style is injected once.
 *
 * Runs against the fake DOM / Jitsi model in harness.cjs, not a real browser:
 * it checks the class and the injected rule, not the painted result.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const CLASS = "sl-student-no-filmstrip";
const STYLE_ID = "sl-student-filmstrip-style";

// A harness whose iframe was created with the given filmstrip config
// (undefined: no config slice at all) and local role, after the store poll.
function setup({ filmstrip, role }) {
    const h = createHarness();

    if (filmstrip !== undefined) {
        h.state["features/base/config"] = { filmstrip };
    }

    h.participants.local = { id: "local01", role, name: "Local" };
    h.timers.advance(600);

    return h;
}

const hasClass = h => h.document.body.classList.contains(CLASS);
const styleOf = h => h.document.getElementById(STYLE_ID);

function setRole(h, role) {
    h.participants.local = { ...h.participants.local, role };
    h.change();
}

test("student config: body class set and the !important rule injected", () => {
    const h = setup({ filmstrip: { disabled: true }, role: "participant" });

    assert.equal(hasClass(h), true);

    const style = styleOf(h);

    assert.ok(style, "style element injected");
    assert.equal(style.parentNode, h.document.head);
    assert.equal(style.textContent, "body." + CLASS + " .filmstrip { display: none !important; }");
});

test("student config before the role is known ('none'): hidden from the start", () => {
    const h = setup({ filmstrip: { disabled: true }, role: "none" });

    assert.equal(hasClass(h), true);
});

test("teacher config before the moderator role arrives: never hidden", () => {
    const h = setup({ filmstrip: { disabled: false }, role: "participant" });

    assert.equal(hasClass(h), false);
    assert.equal(styleOf(h), null);

    setRole(h, "moderator");

    assert.equal(hasClass(h), false);
    assert.equal(styleOf(h), null);
});

test("teacher config demoted from moderator: still never hidden", () => {
    const h = setup({ filmstrip: { disabled: false }, role: "moderator" });

    setRole(h, "participant");

    assert.equal(hasClass(h), false);
});

test("teacher: no class at any point from the first store state on", () => {
    const h = createHarness();
    const seen = [];

    h.state["features/base/config"] = { filmstrip: { disabled: false } };
    h.participants.local = { id: "teacher01", role: "none", name: "Teacher" };

    const record = () => seen.push(hasClass(h));

    record();
    h.timers.advance(600);
    record();
    setRole(h, "participant");
    record();
    setRole(h, "moderator");
    record();

    assert.deepEqual(seen, [false, false, false, false]);
});

test("student promoted to moderator: class removed; demoted again: set again", () => {
    const h = setup({ filmstrip: { disabled: true }, role: "participant" });

    assert.equal(hasClass(h), true);

    setRole(h, "moderator");
    assert.equal(hasClass(h), false);

    setRole(h, "participant");
    assert.equal(hasClass(h), true);
});

test("config changes: disabled true -> false removes the class, back to true sets it", () => {
    const h = setup({ filmstrip: { disabled: true }, role: "participant" });

    h.state["features/base/config"] = { filmstrip: { disabled: false } };
    h.change();
    assert.equal(hasClass(h), false);

    h.state["features/base/config"] = { filmstrip: { disabled: true } };
    h.change();
    assert.equal(hasClass(h), true);

    // Only a real true counts.
    h.state["features/base/config"] = { filmstrip: { disabled: "true" } };
    h.change();
    assert.equal(hasClass(h), false);
});

test("missing config: no config slice, no filmstrip key, or no disabled flag -> never hidden", () => {
    assert.equal(hasClass(setup({ filmstrip: undefined, role: "participant" })), false);

    const noKey = createHarness();

    noKey.state["features/base/config"] = {};
    noKey.participants.local = { id: "local01", role: "participant", name: "Local" };
    noKey.timers.advance(600);
    assert.equal(hasClass(noKey), false);

    assert.equal(hasClass(setup({ filmstrip: {}, role: "participant" })), false);
});

test("before the store exists nothing is touched; it applies once the store is found", () => {
    const h = createHarness();

    h.state["features/base/config"] = { filmstrip: { disabled: true } };
    h.participants.local = { id: "local01", role: "participant", name: "Local" };

    assert.equal(hasClass(h), false);

    h.timers.advance(600);

    assert.equal(hasClass(h), true);
});

test("repeated store updates: <body> class touched only on a change, style injected once", () => {
    const h = setup({ filmstrip: { disabled: true }, role: "participant" });
    const classList = h.document.body.classList;
    const head = h.document.head;
    const originalToggle = classList.toggle.bind(classList);
    const originalAppend = head.appendChild.bind(head);
    let toggles = 0;
    let appends = 0;

    // Only this block's class (other blocks toggle their own on every render).
    classList.toggle = (...args) => {
        if (args[0] === CLASS) {
            toggles += 1;
        }

        return originalToggle(...args);
    };
    head.appendChild = child => {
        if (child && child.id === STYLE_ID) {
            appends += 1;
        }

        return originalAppend(child);
    };

    for (let i = 0; i < 20; i++) {
        h.change();
    }

    assert.equal(toggles, 0, "no class writes while nothing changes");
    assert.equal(appends, 0, "no second style element");
    assert.equal(head.children.filter(el => el.id === STYLE_ID).length, 1);

    setRole(h, "moderator");
    assert.equal(toggles, 1);

    for (let i = 0; i < 20; i++) {
        h.change();
    }

    assert.equal(toggles, 1, "still one write after more unchanged updates");
});

test("student receive constraints are unchanged with the student config", async () => {
    const h = setup({ filmstrip: { disabled: true }, role: "participant" });

    h.addParticipant("teacher99", { role: "moderator" });
    ["stud001", "stud002", "stud003"].forEach(id => h.addParticipant(id));
    h.change();
    h.postFromParent({ type: "SL_STUDENT_VIEW", v: 1, epoch: 1, enabled: true });
    h.change();
    await h.flush();

    const sent = h.lastSent();

    assert.equal(hasClass(h), true);
    assert.deepEqual(Array.from(sent.selectedSources), ["teacher99-v0"]);
    assert.equal(sent.lastN, 1);
    assert.equal(sent.defaultConstraints.maxHeight, 0);
});

test("teacher view (moderator) keeps its own body class and never gets the student class", () => {
    const h = setup({ filmstrip: { disabled: false }, role: "moderator" });

    h.postFromParent({ type: "SL_TEACHER_VIEW", v: 1, epoch: 1, enabled: true });
    h.change();

    assert.equal(h.document.body.classList.contains("sl-teacher-view-active"), true);
    assert.equal(hasClass(h), false);
});
