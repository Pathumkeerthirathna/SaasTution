/*
 * Regression tests: Jitsi's filmstrip hidden in the Jibri recorder's view only
 * (deploy/jitsi/custom.js, "Broadcast Filmstrip Hide (Jibri recorder)").
 *
 *   npm run test:jitsi
 *
 * - Only with config.iAmRecorder (the browser Jibri streams / records from):
 *   Jitsi's own filmstrip visibility is set to hidden with its
 *   SET_FILMSTRIP_VISIBLE action, and <body> gets the class whose rule hides
 *   .filmstrip as a backstop.
 * - Hidden again when something shows it again; never a dispatch loop, and
 *   not repeated when the action has no effect.
 * - Teachers and students (no iAmRecorder) are untouched: no dispatch, no
 *   class, no style.
 *
 * Runs against the fake DOM / Jitsi model in harness.cjs. The reducer below
 * mirrors the deployed Jitsi build (case SET_FILMSTRIP_VISIBLE: {...state,
 * visible}); what a real Jibri renders remains a manual check.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const CLASS = "sl-recorder-no-filmstrip";
const STYLE_ID = "sl-recorder-filmstrip-style";
const ACTION = "SET_FILMSTRIP_VISIBLE";

// config: the features/base/config slice (undefined: none yet). role: the
// local participant's role. reducer: false = a Jitsi that ignores the action.
function setup({ config, role = "participant", reducer = true } = {}) {
    const h = createHarness();
    const dispatchOriginal = h.store.dispatch;

    h.filmstripDispatches = [];
    h.state["features/filmstrip"] = { visible: true };

    if (config !== undefined) {
        h.state["features/base/config"] = config;
    }

    h.store.dispatch = action => {
        if (action.type === ACTION) {
            h.filmstripDispatches.push(action);

            if (reducer) {
                h.state["features/filmstrip"] = { ...h.state["features/filmstrip"], visible: action.visible };
            }
        }

        return dispatchOriginal(action);
    };

    h.participants.local = { id: "local01", role, name: "Local" };
    h.timers.advance(600);

    return h;
}

const hasClass = h => h.document.body.classList.contains(CLASS);
const styleOf = h => h.document.getElementById(STYLE_ID);
const filmstripVisible = h => h.state["features/filmstrip"].visible;

test("recorder: Jitsi's filmstrip is hidden with its own action, plus the scoped CSS backstop", () => {
    const h = setup({ config: { iAmRecorder: true } });

    // Compared by fields: the action object comes from custom.js's vm realm.
    assert.equal(h.filmstripDispatches.length, 1);
    assert.equal(h.filmstripDispatches[0].type, ACTION);
    assert.equal(h.filmstripDispatches[0].visible, false);
    assert.equal(filmstripVisible(h), false, "Jitsi's state: hidden, so the large video takes the full width");
    assert.equal(hasClass(h), true);

    const style = styleOf(h);

    assert.ok(style, "style element injected");
    assert.equal(style.parentNode, h.document.head);
    assert.equal(style.textContent, "body." + CLASS + " .filmstrip { display: none !important; }");
});

test("recorder: no dispatch loop; further store changes do not dispatch again", () => {
    const h = setup({ config: { iAmRecorder: true } });

    for (let i = 0; i < 20; i++) {
        h.change();
    }

    h.timers.advance(5000);

    assert.equal(h.filmstripDispatches.length, 1);
});

test("recorder: shown again by another action -> hidden again, once", () => {
    const h = setup({ config: { iAmRecorder: true } });

    h.state["features/filmstrip"] = { ...h.state["features/filmstrip"], visible: true };
    h.change();
    h.change();

    assert.equal(h.filmstripDispatches.length, 2);
    assert.equal(filmstripVisible(h), false);
});

test("recorder: a Jitsi that ignores the action is not asked repeatedly; the CSS backstop still applies", () => {
    const h = setup({ config: { iAmRecorder: true }, reducer: false });

    for (let i = 0; i < 10; i++) {
        h.change();
    }

    assert.equal(h.filmstripDispatches.length, 1);
    assert.equal(hasClass(h), true);
});

test("recorder config arriving after the store: hidden then", () => {
    const h = setup({ config: undefined });

    assert.equal(h.filmstripDispatches.length, 0);

    h.state["features/base/config"] = { iAmRecorder: true };
    h.change();

    assert.equal(h.filmstripDispatches.length, 1);
    assert.equal(filmstripVisible(h), false);
    assert.equal(hasClass(h), true);
});

test("teacher (moderator): untouched, no dispatch, no class, no style", () => {
    const h = setup({ config: { filmstrip: { disabled: false } }, role: "moderator" });

    h.change();
    h.timers.advance(5000);

    assert.equal(h.filmstripDispatches.length, 0);
    assert.equal(filmstripVisible(h), true);
    assert.equal(hasClass(h), false);
    assert.equal(styleOf(h), null);
});

test("student: untouched by this block; the existing Student Filmstrip Hide still applies", () => {
    const h = setup({ config: { filmstrip: { disabled: true } }, role: "participant" });

    h.change();

    assert.equal(h.filmstripDispatches.length, 0);
    assert.equal(filmstripVisible(h), true);
    assert.equal(hasClass(h), false);
    assert.equal(styleOf(h), null);
    assert.equal(h.document.body.classList.contains("sl-student-no-filmstrip"), true);
});

test("iAmRecorder must be exactly true (a missing or false flag is a normal participant)", () => {
    for (const config of [{ iAmRecorder: false }, { iAmRecorder: "true" }, {}]) {
        const h = setup({ config });

        assert.equal(h.filmstripDispatches.length, 0, JSON.stringify(config));
        assert.equal(hasClass(h), false, JSON.stringify(config));
    }
});
