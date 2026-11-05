/*
 * Unit tests: the role-based camera codec order (components/Jitsi/
 * jitsi-codec-preferences.mjs) added to the Jitsi iframe's configOverwrite
 * when the app is built with NEXT_PUBLIC_SL_ROLE_CODEC_ORDER=true.
 *
 *   npm run test:jitsi
 *
 * These check the configuration the page hands to Jitsi. Whether Jitsi applies
 * it, and which codec a real browser then sends, needs a real meeting.
 */

"use strict";

const path = require("path");
const { pathToFileURL } = require("url");
const test = require("node:test");
const assert = require("node:assert/strict");

let modulePromise = null;
let bitrateModulePromise = null;

function load() {
    modulePromise = modulePromise || import(pathToFileURL(
        path.join(__dirname, "..", "..", "components", "Jitsi", "jitsi-codec-preferences.mjs")).href);

    return modulePromise;
}

function loadBitrate() {
    bitrateModulePromise = bitrateModulePromise || import(pathToFileURL(
        path.join(__dirname, "..", "..", "components", "Jitsi", "teacher-camera-preferences.mjs")).href);

    return bitrateModulePromise;
}

const TEACHER = ["AV1", "VP8", "VP9", "H264"];
const STUDENT = ["VP8", "VP9", "H264", "AV1"];

test("disabled: nothing is added for any role", async () => {
    const { buildCodecPreferenceConfig } = await load();

    for (const role of ["teacher", "student", "admin", undefined, ""]) {
        assert.deepEqual(buildCodecPreferenceConfig(role, false), {}, String(role));
    }
});

test("only a real true enables it (the flag is a boolean, never a truthy string)", async () => {
    const { buildCodecPreferenceConfig } = await load();

    for (const flag of [undefined, null, "true", 1, "false"]) {
        assert.deepEqual(buildCodecPreferenceConfig("teacher", flag), {}, String(flag));
    }
});

test("teacher: AV1 first, VP8 (not VP9) as the fallback; no mobile key", async () => {
    const { buildCodecPreferenceConfig } = await load();

    assert.deepEqual(buildCodecPreferenceConfig("teacher", true), {
        "videoQuality.codecPreferenceOrder": TEACHER
    });
});

test("student: VP8 first, on desktop and on phones", async () => {
    const { buildCodecPreferenceConfig } = await load();

    assert.deepEqual(buildCodecPreferenceConfig("student", true), {
        "videoQuality.codecPreferenceOrder": STUDENT,
        "videoQuality.mobileCodecPreferenceOrder": STUDENT
    });
});

test("unknown roles get nothing", async () => {
    const { buildCodecPreferenceConfig } = await load();

    for (const role of ["admin", "moderator", undefined, null, "", "Teacher"]) {
        assert.deepEqual(buildCodecPreferenceConfig(role, true), {}, String(role));
    }
});

test("every call returns fresh arrays; the exported orders cannot be changed", async () => {
    const { buildCodecPreferenceConfig, TEACHER_CODEC_ORDER, STUDENT_CODEC_ORDER } = await load();

    const first = buildCodecPreferenceConfig("teacher", true);

    first["videoQuality.codecPreferenceOrder"].reverse();

    assert.deepEqual(buildCodecPreferenceConfig("teacher", true)["videoQuality.codecPreferenceOrder"], TEACHER);
    assert.deepEqual([...TEACHER_CODEC_ORDER], TEACHER);

    const student = buildCodecPreferenceConfig("student", true);

    assert.notEqual(student["videoQuality.codecPreferenceOrder"], student["videoQuality.mobileCodecPreferenceOrder"]);
    assert.ok(Object.isFrozen(TEACHER_CODEC_ORDER));
    assert.ok(Object.isFrozen(STUDENT_CODEC_ORDER));
});

test("dotted videoQuality keys only, never a whole videoQuality object", async () => {
    const { buildCodecPreferenceConfig } = await load();

    for (const role of ["teacher", "student"]) {
        const keys = Object.keys(buildCodecPreferenceConfig(role, true));

        assert.ok(keys.length > 0, role);
        keys.forEach(key => assert.match(key, /^videoQuality\.[A-Za-z]+$/, key));
        assert.ok(!keys.includes("videoQuality"), role);
    }
});

test("merged with the teacher bitrate keys: no collision, both kept", async () => {
    const { buildCodecPreferenceConfig } = await load();
    const { buildTeacherBitrateConfig } = await loadBitrate();

    const bitrate = buildTeacherBitrateConfig("teacher");
    const codec = buildCodecPreferenceConfig("teacher", true);
    const merged = { ...bitrate, ...codec };

    Object.keys(codec).forEach(key => assert.ok(!(key in bitrate), key));
    assert.equal(Object.keys(merged).length, Object.keys(bitrate).length + Object.keys(codec).length);
    assert.deepEqual(merged["videoQuality.codecPreferenceOrder"], TEACHER);
    Object.entries(bitrate).forEach(([key, value]) => assert.equal(merged[key], value, key));
});

test("each order lists AV1, VP8, VP9 and H264 exactly once (nothing is disabled)", async () => {
    const { TEACHER_CODEC_ORDER, STUDENT_CODEC_ORDER } = await load();

    for (const order of [TEACHER_CODEC_ORDER, STUDENT_CODEC_ORDER]) {
        assert.deepEqual([...order].sort(), ["AV1", "H264", "VP8", "VP9"]);
    }
});

test("fallback for an iPhone (which lists vp8, h264, vp9): teacher picks VP8, students stay VP8", async () => {
    const { TEACHER_CODEC_ORDER, STUDENT_CODEC_ORDER } = await load();

    // lib-jitsi-meet's rule: the first codec of the sender's own order that
    // every participant lists (codec names are compared in lower case).
    const pick = (order, lists) => order
        .map(codec => codec.toLowerCase())
        .find(codec => lists.every(list => list.includes(codec)));

    const desktop = ["av1", "vp9", "vp8", "h264"];
    const iphone = ["vp8", "h264", "vp9"];

    assert.equal(pick(TEACHER_CODEC_ORDER, [desktop, desktop]), "av1");
    assert.equal(pick(TEACHER_CODEC_ORDER, [desktop, iphone]), "vp8");
    assert.equal(pick(STUDENT_CODEC_ORDER, [desktop, desktop]), "vp8");
    assert.equal(pick(STUDENT_CODEC_ORDER, [desktop, iphone]), "vp8");
});
