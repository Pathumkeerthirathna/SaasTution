/*
 * Regression tests: Jitsi's Settings button visibility (deploy/jitsi/custom.js,
 * "Settings Button Visibility"). Hidden only where Jitsi 9442 shows the
 * microphone / camera arrow menus (not Android / iOS, not a narrow layout);
 * kept on Android, iOS / iPadOS and narrow layouts (meeting area under 512 px).
 * Changed with Jitsi's own OVERWRITE_CONFIG, only when visibility flips.
 *
 *   npm run test:jitsi
 *
 * Jitsi's config reducer is MOCKED as in the deployed 9442 bundle (a shallow
 * merge of action.config into "features/base/config"; Jitsi then recomputes
 * the visible toolbar buttons from it). What the real toolbar renders needs a
 * real browser.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHarness } = require("./harness.cjs");

const plain = value => JSON.parse(JSON.stringify(value));

const NAVIGATORS = {
    windowsChrome: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", maxTouchPoints: 0, platform: "Win32" },
    macSafari: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", maxTouchPoints: 0, platform: "MacIntel" },
    android: { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", maxTouchPoints: 5, platform: "Linux armv8l" },
    androidTablet: { userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", maxTouchPoints: 10, platform: "Linux armv8l" },
    iphone: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5, platform: "iPhone" },
    // iPadOS asks for the desktop site: a Mac user agent, but touch.
    ipadOs: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", maxTouchPoints: 5, platform: "MacIntel" }
};

const TEACHER = ["microphone", "camera", "desktop", "hangup", "fullscreen", "settings", "videoquality", "select-background", "toggle-camera"];
const STUDENT = ["microphone", "camera", "raisehand", "fullscreen", "settings", "videoquality", "shortcuts", "hangup", "desktop", "toggle-camera"];

async function settle(h) {
    for (let i = 0; i < 4; i += 1) {
        await h.flush();
    }
}

async function setup({ navigator = NAVIGATORS.windowsChrome, toolbar = TEACHER, narrow = false, role = "moderator" } = {}) {
    const h = createHarness({ navigator });
    const overwrites = [];
    const original = h.store.dispatch;

    h.participants.local.role = role;
    h.state["features/base/config"] = { toolbarButtons: [...toolbar], channelLastN: 5 };
    h.state["features/base/responsive-ui"] = { isNarrowLayout: narrow, videoSpaceWidth: narrow ? 480 : 1200 };
    h.store.dispatch = action => {
        if (action.type === "OVERWRITE_CONFIG") {
            overwrites.push(plain(action));
            h.state["features/base/config"] = { ...h.state["features/base/config"], ...action.config };
        }

        return original(action);
    };

    h.timers.advance(600);
    h.change();
    await settle(h);

    return { h, overwrites };
}

const buttons = h => plain(h.state["features/base/config"].toolbarButtons);

async function setNarrow(h, narrow) {
    h.state["features/base/responsive-ui"] = { isNarrowLayout: narrow, videoSpaceWidth: narrow ? 480 : 1200 };
    h.change();
    await settle(h);
}

test("desktop, meeting area >= 512 px: Settings hidden (teacher), every other button kept in order", async () => {
    const { h, overwrites } = await setup();

    assert.equal(overwrites.length, 1);
    assert.deepEqual(buttons(h), TEACHER.filter(button => button !== "settings"));
    assert.deepEqual(Object.keys(overwrites[0].config), ["toolbarButtons"], "only the toolbar is overwritten");
    assert.equal(h.state["features/base/config"].channelLastN, 5, "the rest of the config is kept");
});

test("desktop student: the same rule (hidden on a wide layout)", async () => {
    const { h } = await setup({ toolbar: STUDENT, role: "participant" });

    assert.deepEqual(buttons(h), STUDENT.filter(button => button !== "settings"));
});

test("Mac Safari desktop: hidden like Windows", async () => {
    const { h } = await setup({ navigator: NAVIGATORS.macSafari });

    assert.ok(!buttons(h).includes("settings"));
});

for (const [name, navigator] of Object.entries({
    "Android phone": NAVIGATORS.android,
    "Android tablet": NAVIGATORS.androidTablet,
    iPhone: NAVIGATORS.iphone,
    "iPadOS (desktop user agent, touch)": NAVIGATORS.ipadOs
})) {
    test(`${name}: Settings stays (no arrow menus there), nothing dispatched`, async () => {
        for (const toolbar of [TEACHER, STUDENT]) {
            const { h, overwrites } = await setup({ navigator, toolbar });

            assert.deepEqual(overwrites, []);
            assert.deepEqual(buttons(h), toolbar);

            // Even on a wide layout and after many store changes.
            await setNarrow(h, false);
            assert.deepEqual(overwrites, []);
        }
    });
}

test("narrow layout (meeting area < 512 px) on desktop: Settings shown; widening hides it again", async () => {
    const { h, overwrites } = await setup({ narrow: true });

    assert.deepEqual(overwrites, [], "already shown");
    assert.ok(buttons(h).includes("settings"));

    await setNarrow(h, false);
    assert.ok(!buttons(h).includes("settings"));

    await setNarrow(h, true);
    assert.ok(buttons(h).includes("settings"));
    assert.equal(overwrites.length, 2);

    // Back on the toolbar, every other button is still there.
    for (const button of TEACHER) {
        assert.ok(buttons(h).includes(button), button);
    }
});

test("dispatched only when visibility flips: store changes and time do nothing", async () => {
    const { h, overwrites } = await setup();

    for (let i = 0; i < 25; i += 1) {
        h.change();
    }

    h.timers.advance(120000);
    await setNarrow(h, false);

    assert.equal(overwrites.length, 1);
});

test("a toolbar the page configured WITHOUT Settings is never given one", async () => {
    const toolbar = TEACHER.filter(button => button !== "settings");
    const { h, overwrites } = await setup({ toolbar, narrow: true });

    await setNarrow(h, false);
    await setNarrow(h, true);

    assert.deepEqual(overwrites, []);
    assert.deepEqual(buttons(h), toolbar);
});

test("before Jitsi has its config (no toolbarButtons yet), nothing happens", async () => {
    const h = createHarness({ navigator: NAVIGATORS.windowsChrome });
    let dispatched = 0;
    const original = h.store.dispatch;

    h.store.dispatch = action => {
        if (action.type === "OVERWRITE_CONFIG") {
            dispatched += 1;
        }

        return original(action);
    };

    h.timers.advance(600);
    h.change();
    await settle(h);

    assert.equal(dispatched, 0);
});
