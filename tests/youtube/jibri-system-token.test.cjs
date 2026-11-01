/*
 * The system moderator token (lib/jitsi-auth.ts generateSystemJitsiToken)
 * for the backend Jibri stop: one exact classroom, <= 90 s, a dedicated
 * identity with owner / moderator claims, the existing signing conventions.
 * The teacher / student token (generateJitsiToken) is byte-for-byte what the
 * committed version produces.
 *
 *   npm run test:youtube
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const SECRET = "test-only-secret-not-a-real-one";

process.env.JITSI_JWT_SECRET = SECRET;
delete process.env.JITSI_JWT_AUD;
delete process.env.JITSI_JWT_ISS;
delete process.env.JITSI_JWT_SUB;

const auth = require(path.join(root, "lib/jitsi-auth.ts"));
const { jwtVerify } = require("jose");

const ROOM = "saastution-class001-k9x2ab";
const DOMAIN = "meet.slclassroom.live";

function decode(token) {
    const [header, payload] = token.split(".");
    const part = p => JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return { header: part(header), payload: part(payload) };
}

async function withFixedNow(ms, fn) {
    const saved = Date.now;
    Date.now = () => ms;
    try {
        return await fn();
    } finally {
        Date.now = saved;
    }
}

// The committed lib/jitsi-auth.ts (before the system token), compiled in memory.
function loadCommittedJitsiAuth() {
    const source = execFileSync("git", ["show", "HEAD:lib/jitsi-auth.ts"], { cwd: root, encoding: "utf8" });
    const { transformSync } = require("esbuild");
    const { code } = transformSync(source, { loader: "ts", format: "cjs" });
    const filename = path.join(root, "lib", "__committed-jitsi-auth.ts");
    const mod = new Module(filename);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(code, filename);
    return mod.exports;
}

test("system token: exact room, <= 90 s, dedicated identity, owner + moderator, HS256 with the existing conventions", async () => {
    const token = await auth.generateSystemJitsiToken({ room: ROOM, jitsiDomain: DOMAIN });
    const { header, payload } = decode(token);

    assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
    assert.equal(payload.room, ROOM);
    assert.notEqual(payload.room, "*");
    assert.equal(payload.aud, "jitsi");
    assert.equal(payload.iss, "saastution");
    assert.equal(payload.sub, DOMAIN);
    assert.ok(payload.exp - payload.iat <= 90 && payload.exp > payload.iat);
    assert.deepEqual(payload.context, {
        user: { id: "system:jibri-stop", name: "SL Classroom System", moderator: "true", affiliation: "owner" }
    });

    const { payload: verified } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
        algorithms: ["HS256"], audience: "jitsi", issuer: "saastution"
    });
    assert.equal(verified.room, ROOM);
});

test("system token follows JITSI_JWT_AUD / ISS / SUB exactly like the teacher token", async () => {
    Object.assign(process.env, { JITSI_JWT_AUD: "aud-x", JITSI_JWT_ISS: "saastution", JITSI_JWT_SUB: "sub-x" });
    try {
        const system = decode(await auth.generateSystemJitsiToken({ room: ROOM, jitsiDomain: DOMAIN })).payload;
        const teacher = decode(await auth.generateJitsiToken({ name: "T", room: ROOM, moderator: true, jitsiDomain: DOMAIN })).payload;

        assert.deepEqual([system.aud, system.iss, system.sub], [teacher.aud, teacher.iss, teacher.sub]);
    } finally {
        delete process.env.JITSI_JWT_AUD;
        delete process.env.JITSI_JWT_ISS;
        delete process.env.JITSI_JWT_SUB;
    }
});

test("invalid or wildcard rooms and invalid domains are refused (and the error names no secret)", async () => {
    for (const room of ["*", "", "saastution-*", "SAASTUTION-CLASS001-K9X2AB", "saastution-class001-k9x2ab@x", "../saastution-a-b", "other-room", "saastution-class001-k9x2ab/focus"]) {
        await assert.rejects(auth.generateSystemJitsiToken({ room, jitsiDomain: DOMAIN }), error => {
            assert.ok(!String(error.message).includes(SECRET));
            return /invalid room/.test(error.message);
        }, room);
    }
    for (const jitsiDomain of ["", "*", "localhost", "meet.slclassroom.live/x", "MEET..live", "meet slclassroom.live"]) {
        await assert.rejects(auth.generateSystemJitsiToken({ room: ROOM, jitsiDomain }), /invalid Jitsi domain/, jitsiDomain);
    }
});

test("teacher and student tokens are byte-for-byte those of the committed generateJitsiToken", async () => {
    const committed = loadCommittedJitsiAuth();
    const fixed = Date.UTC(2026, 9, 31, 12, 0, 0);

    for (const payload of [
        { name: "Teacher Name (Teacher)", room: ROOM, moderator: true, jitsiDomain: DOMAIN },
        { name: "Student Name", room: ROOM, moderator: false, jitsiDomain: DOMAIN }
    ]) {
        const now = await withFixedNow(fixed, () => auth.generateJitsiToken(payload));
        const before = await withFixedNow(fixed, () => committed.generateJitsiToken(payload));

        assert.equal(now, before, "unchanged for moderator=" + payload.moderator);
        assert.equal(decode(now).payload.exp - decode(now).payload.iat, 3600);
        assert.equal(decode(now).payload.context.user.id, undefined, "no system identity on user tokens");
    }
});
