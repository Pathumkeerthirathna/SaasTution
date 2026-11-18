/*
 * Teacher profile photos on unified storage: upload / replace / remove, the
 * quota (category PROFILE_IMAGE) through the REAL reservation and usage
 * services, the serving routes (unified and hardened legacy), the orphan
 * sweep, pending-removal retry and the inventory.
 *
 *   npm run test:storage-quota
 *
 * FAKE database: lib/prisma.ts is an in-memory model (teacherProfile with the
 * migration's CHECKs and unique keys, storageReservation, transactions with
 * rollback, and the teacher quota advisory lock emulated as a real mutex held
 * until the transaction ends). This proves the application logic and its
 * interleavings, NOT PostgreSQL behaviour. Real filesystem in temporary
 * folders: "<base>/app" is process.cwd() (legacy storage/teachers) and
 * "<base>/files" is FILE_STORAGE_ROOT.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const B = (n) => BigInt(n);

// ---- Images (real signatures) --------------------------------------------------------------------------------

function png(size = 400) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const fill = Buffer.alloc(Math.max(0, size - head.length - iend.length), 7);
  return Buffer.concat([head, fill, iend]);
}
function jpeg(size = 400) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
  const fill = Buffer.alloc(Math.max(0, size - head.length - 2), 3);
  return Buffer.concat([head, fill, Buffer.from([0xff, 0xd9])]);
}
function webp(size = 400) {
  const body = Buffer.alloc(size - 8, 1);
  body.write("WEBP", 0, "ascii");
  body.write("VP8 ", 4, "ascii");
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(size - 8, 4);
  return Buffer.concat([header, body]);
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100, 1)]);

// ---- Fake database --------------------------------------------------------------------------------------------

const T = "teacher-a";
const T2 = "teacher-b";
const db = {};
function resetDb() {
  Object.assign(db, {
    teacherId: T,
    profiles: [],
    reservations: [],
    limits: [],
    otherBytes: { notes: B(0), submissions: B(0) },
    hooks: {},
    logged: [],
    locks: new Map(),
    lockLog: [],
    clock: Date.parse("2026-11-17T10:00:00.000Z"),
  });
}
resetDb();

const PROFILE_KEY = /^Teachers\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/Profile\/Photo\/[0-9a-f]{32}\.(jpg|png|webp)$/;
function checkProfile(p) {
  const set = [p.profileImageStorageKey, p.profileImageSha256, p.profileImageSizeBytes, p.profileImageMimeType].map((v) => v !== null && v !== undefined);
  assert.ok(set.every((v) => v === set[0]), "CHECK all_or_none");
  if (set[0]) {
    assert.match(p.profileImageStorageKey, PROFILE_KEY, "CHECK storageKey_format");
    assert.ok(p.profileImageStorageKey.startsWith(`Teachers/${p.teacherId}/`), "CHECK storageKey_owner");
    assert.match(p.profileImageSha256, /^[0-9a-f]{64}$/);
    assert.ok(p.profileImageSizeBytes >= 1 && p.profileImageSizeBytes <= 2097152, "CHECK size range");
    assert.ok(["image/jpeg", "image/png", "image/webp"].includes(p.profileImageMimeType));
  }
}
const prismaError = (code) => Object.assign(new Error(`fake ${code}`), { name: "PrismaClientKnownRequestError", code });

function matchValue(value, cond) {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    if ("in" in cond) return cond.in.includes(value);
    if ("not" in cond) return cond.not === null ? value !== null && value !== undefined : value !== cond.not;
    if ("gt" in cond) return value > cond.gt;
    if ("lte" in cond) return value <= cond.lte;
    throw new Error(`fake: unsupported ${JSON.stringify(cond)}`);
  }
  return (value ?? null) === (cond ?? null);
}
const matches = (row, where = {}) => Object.entries(where).every(([k, c]) => c === undefined || matchValue(row[k], c));
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, row[k] ?? null])) : { ...row });

function client(tx) {
  return {
    teacherProfile: {
      async findUnique({ where, select }) {
        const row = db.profiles.find((p) => p.teacherId === where.teacherId);
        return row ? pick(row, select) : null;
      },
      async findFirst({ where, select }) {
        const row = db.profiles.find((p) => matches(p, where));
        return row ? pick(row, select) : null;
      },
      async findMany({ where, take, select }) {
        return db.profiles.filter((p) => matches(p, where)).sort((a, b) => (a.teacherId < b.teacherId ? -1 : 1)).slice(0, take).map((p) => pick(p, select));
      },
      async updateMany({ where, data }) {
        if (db.hooks.beforeUpdateMany) await db.hooks.beforeUpdateMany(where, data);
        const rows = db.profiles.filter((p) => matches(p, where));
        for (const row of rows) {
          const next = { ...row, ...data };
          checkProfile(next);
          if (next.profileImageStorageKey && db.profiles.some((p) => p !== row && p.profileImageStorageKey === next.profileImageStorageKey)) throw prismaError("P2002");
          Object.assign(row, next);
        }
        return { count: rows.length };
      },
      async create({ data, select }) {
        if (db.profiles.some((p) => p.teacherId === data.teacherId)) throw prismaError("P2002");
        const row = { id: `profile-${data.teacherId}`, profileImageUrl: null, profileImageStorageKey: null, profileImageSha256: null, profileImageSizeBytes: null, profileImageMimeType: null, ...data };
        checkProfile(row);
        db.profiles.push(row);
        return pick(row, select);
      },
    },
    storageReservation: {
      async create({ data, select }) {
        assert.ok(["NOTE", "SUBMISSION", "PROFILE_IMAGE"].includes(data.category));
        assert.ok(data.storageKey.startsWith(`Teachers/${data.teacherId}/`), "reservation owner CHECK");
        if (data.category === "PROFILE_IMAGE") assert.match(data.storageKey, PROFILE_KEY, "reservation key CHECK");
        db.reservations.push({ ...data });
        return pick(data, select);
      },
      async findUnique({ where, select }) {
        const row = db.reservations.find((r) => r.id === where.id);
        return row ? pick(row, select) : null;
      },
      async findMany({ where, select }) {
        return db.reservations.filter((r) => matches(r, where)).map((r) => pick(r, select));
      },
      async deleteMany({ where }) {
        const before = db.reservations.length;
        db.reservations = db.reservations.filter((r) => !matches(r, where));
        return { count: before - db.reservations.length };
      },
      async groupBy({ where }) {
        const groups = new Map();
        for (const r of db.reservations.filter((x) => matches(x, where))) groups.set(r.category, (groups.get(r.category) ?? B(0)) + r.bytes);
        return [...groups].map(([category, bytes]) => ({ category, _sum: { bytes } }));
      },
    },
    recordingUploadSession: { findMany: async () => [] },
    recordedLecture: { aggregate: async () => ({ _sum: { sizeBytes: null } }) },
    teacherStorageLimit: { findUnique: async ({ where }) => db.limits.find((l) => l.teacherId === where.teacherId) ?? null },
    teacherSubscription: { findFirst: async () => null },
    $queryRaw: async () => [{ notesBytes: db.otherBytes.notes, submissionsBytes: db.otherBytes.submissions }],
    // The quota advisory lock: a real per-key mutex, held until the transaction ends.
    async $executeRaw(strings, ...values) {
      if (!tx) throw new Error("advisory lock outside a transaction");
      const key = String(values[0]);
      db.lockLog.push(key);
      for (;;) {
        const held = db.locks.get(key);
        if (!held) break;
        await held.promise;
      }
      let release;
      db.locks.set(key, { promise: new Promise((r) => (release = r)) });
      tx.held.push(() => {
        db.locks.delete(key);
        release();
      });
    },
    $executeRawUnsafe: async () => undefined,
  };
}

const prisma = {
  ...client(null),
  async $transaction(fn) {
    // Batch form ($transaction([...queries], options)): the queries in order.
    if (Array.isArray(fn)) return Promise.all(fn);
    const tx = { held: [] };
    const snapshot = structuredClone({ profiles: db.profiles, reservations: db.reservations });
    const c = client(tx);
    try {
      return await fn(c);
    } catch (error) {
      db.profiles = snapshot.profiles;
      db.reservations = snapshot.reservations;
      throw error;
    } finally {
      for (const release of tx.held) release();
    }
  },
};
fake("lib/prisma.ts", { prisma });
fake("lib/server-clock.ts", { serverNow: async () => new Date(db.clock), serverNowSync: () => new Date(db.clock) });
fake("lib/error-logging/server-logger.ts", {
  logErrorEntry: (error, context) => {
    db.logged.push({ error, url: context?.request?.url });
    return null;
  },
});
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
let bodyReadBeforeAuth = false;
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!db.teacherId) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { role: "TEACHER", teacherId: db.teacherId, email: "t@example.test", name: "T" };
  },
});

const OR = require(path.join(root, "lib", "file-storage", "open-root.ts"));
const K = require(path.join(root, "lib", "profile-images", "storage-keys.ts"));
const SIG = require(path.join(root, "lib", "profile-images", "image-signature.ts"));
const PHOTO = require(path.join(root, "services", "teacher-profile-photo-service.ts"));
const USAGE = require(path.join(root, "services", "teacher-storage-usage-service.ts"));
const INV = require(path.join(root, "lib", "storage-migration", "inventory-filesystem.ts"));
const route = (...p) => require(path.join(root, "app", ...p, "route.ts"));
const photoRoute = route("api", "teacher", "profile", "photo");
const servingRoute = route("api", "teacher-photos", "[teacherId]", "[file]");
const legacyRoute = route("uploads", "teachers", "[filename]");

// ---- Sandbox ------------------------------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";
async function withSandbox(fn, { configureRoot = true } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "photo-"));
  const app = path.join(base, "app");
  const files = path.join(base, "files");
  fs.mkdirSync(path.join(app, "storage", "teachers"), { recursive: true });
  fs.mkdirSync(files);
  const saved = { cwd: process.cwd(), root: process.env.FILE_STORAGE_ROOT, app: process.env.APP_URL };
  if (configureRoot) process.env.FILE_STORAGE_ROOT = files;
  else delete process.env.FILE_STORAGE_ROOT;
  process.env.APP_URL = ORIGIN;
  OR.resetSharedFileStorageCacheForTests();
  process.chdir(app);
  try {
    return await fn({
      base,
      app,
      files,
      setRoot(on) {
        if (on) process.env.FILE_STORAGE_ROOT = files;
        else delete process.env.FILE_STORAGE_ROOT;
        OR.resetSharedFileStorageCacheForTests();
      },
    });
  } finally {
    process.chdir(saved.cwd);
    for (const [k, v] of [["FILE_STORAGE_ROOT", saved.root], ["APP_URL", saved.app]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    OR.resetSharedFileStorageCacheForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
function filesBelow(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}
const keyPath = (s, key) => path.join(s.files, ...key.split("/"));

function upload(bytes, { type = "image/png", name = "photo.png", origin = ORIGIN, field = "photo" } = {}) {
  const form = new FormData();
  form.set(field, new File([bytes], name, { type }));
  const headers = origin ? { origin } : {};
  return photoRoute.PUT(new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", body: form, headers }));
}
const remove = (origin = ORIGIN) => photoRoute.DELETE(new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "DELETE", headers: origin ? { origin } : {} }));
const getOwn = () => photoRoute.GET(new Request(`${ORIGIN}/api/teacher/profile/photo`));
const json = async (r) => ({ status: r.status, body: await r.json() });
const serve = (teacherId, file) => servingRoute.GET(new Request(`${ORIGIN}/api/teacher-photos/x/y`), { params: { teacherId, file } });
const serveLegacy = (filename) => legacyRoute.GET(new Request(`${ORIGIN}/uploads/teachers/x`), { params: { filename } });
const profileOf = (teacherId = T) => db.profiles.find((p) => p.teacherId === teacherId) ?? null;
const usage = (teacherId = T) => USAGE.getTeacherStorageUsage(teacherId, { now: new Date(db.clock) });

test.beforeEach(() => {
  resetDb();
  bodyReadBeforeAuth = false;
  PHOTO.resetProfilePhotoMaintenanceStateForTests();
});

// ==== 1. Security ===========================================================================================

test("security: cross-origin writes are refused (403) before the session or the body is read", async () => {
  await withSandbox(async () => {
    for (const origin of [null, "https://evil.example"]) {
      const res = await json(await upload(png(), { origin }));
      assert.equal(res.status, 403, String(origin));
      assert.equal(res.body.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
      assert.equal((await remove(origin)).status, 403);
    }
    const crossSite = await photoRoute.PUT(new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", headers: { origin: ORIGIN, "sec-fetch-site": "cross-site" }, body: "x" }));
    assert.equal(crossSite.status, 403);
    assert.equal(db.profiles.length, 0);
  });
});

test("security: unauthenticated -> 401 and the body is never read", async () => {
  await withSandbox(async () => {
    db.teacherId = null;
    // highWaterMark 0: pull() runs only when something actually reads the body.
    const body = new ReadableStream(
      {
        pull(controller) {
          bodyReadBeforeAuth = true;
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const res = await photoRoute.PUT(
      new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", body, duplex: "half", headers: { origin: ORIGIN, "content-type": "multipart/form-data; boundary=x" } })
    );
    assert.equal(res.status, 401);
    assert.equal(bodyReadBeforeAuth, false, "the session is checked before any of the body is read");
    // Control: an authenticated request does read it.
    db.teacherId = T;
    const read = new ReadableStream({ pull(c) { bodyReadBeforeAuth = true; c.enqueue(new Uint8Array(10)); c.close(); } }, { highWaterMark: 0 });
    await photoRoute.PUT(new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", body: read, duplex: "half", headers: { origin: ORIGIN, "content-type": "multipart/form-data; boundary=x" } }));
    assert.equal(bodyReadBeforeAuth, true, "the probe detects reads");
    db.teacherId = null;
    assert.equal((await remove()).status, 401);
    assert.equal((await getOwn()).status, 401);
  });
});

test("security: 2 MB limit - by Content-Length, and while streaming without one; exactly 2 MB is accepted", async () => {
  await withSandbox(async (s) => {
    const declared = await photoRoute.PUT(
      new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", body: "x", headers: { origin: ORIGIN, "content-type": "multipart/form-data; boundary=x", "content-length": String(3 * 1024 * 1024) } })
    );
    assert.equal(declared.status, 413);
    let pulled = 0;
    const endless = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulled > 100) controller.close();
      },
    });
    const streamed = await json(
      await photoRoute.PUT(new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", body: endless, duplex: "half", headers: { origin: ORIGIN, "content-type": "multipart/form-data; boundary=x" } }))
    );
    assert.equal(streamed.status, 413);
    assert.equal(streamed.body.error.code, "PROFILE_PHOTO_TOO_LARGE");
    assert.ok(pulled <= 10, `stopped early (read ${pulled} chunks)`);
    const over = await json(await upload(png(2 * 1024 * 1024 + 1)));
    assert.equal(over.status, 413);
    const exact = await json(await upload(png(2 * 1024 * 1024)));
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    assert.equal(filesBelow(s.files).length, 1);
  });
});

test("security: content decides - SVG, HTML, GIF, malformed / truncated images and MIME spoofing are refused (415); nothing stored, nothing reserved", async () => {
  await withSandbox(async (s) => {
    const cases = [
      [SVG, "image/svg+xml", "a.svg"],
      [SVG, "image/png", "a.png"], // spoofed type and name
      [HTML, "image/jpeg", "a.jpg"],
      [GIF, "image/gif", "a.gif"],
      [png().subarray(0, 200), "image/png", "truncated.png"], // no IEND
      [jpeg().subarray(0, 300), "image/jpeg", "truncated.jpg"], // no EOI
      [Buffer.concat([webp(), Buffer.alloc(4)]), "image/webp", "bad.webp"], // RIFF size wrong
      [Buffer.alloc(10, 0xff), "image/png", "tiny.png"],
    ];
    for (const [bytes, type, name] of cases) {
      const res = await json(await upload(bytes, { type, name }));
      assert.equal(res.status, 415, name);
      assert.equal(res.body.error.code, "PROFILE_PHOTO_INVALID_IMAGE", name);
    }
    const notMultipart = await photoRoute.PUT(new Request(`${ORIGIN}/api/teacher/profile/photo`, { method: "PUT", body: "{}", headers: { origin: ORIGIN, "content-type": "application/json" } }));
    assert.equal(notMultipart.status, 415);
    assert.equal((await upload(png(), { field: "other" })).status, 400, "no photo field");
    assert.deepEqual(filesBelow(s.files), []);
    assert.deepEqual(db.reservations, []);
    assert.equal(db.profiles.length, 0);
  });
});

test("signatures: JPEG / PNG / WebP detected from bytes only (the declared type is ignored)", async () => {
  const detect = (buf) => SIG.detectBlobProfilePhotoType(new Blob([buf], { type: "text/html" }));
  assert.equal(await detect(png()), "image/png");
  assert.equal(await detect(jpeg()), "image/jpeg");
  assert.equal(await detect(webp()), "image/webp");
  assert.equal(await detect(Buffer.concat([jpeg(), Buffer.alloc(8)])), "image/jpeg", "zero padding after EOI");
  assert.equal(await detect(Buffer.concat([jpeg(), Buffer.from("<script>")])), null, "data after EOI");
  for (const bad of [SVG, HTML, GIF, Buffer.alloc(0)]) assert.equal(await detect(bad), null);
});

// ==== 2. Storage ==============================================================================================

test("storage: Teachers/{teacherId}/Profile/Photo/{32 hex}.{ext}, exact bytes and SHA-256; versioned URL; type from content", async () => {
  await withSandbox(async (s) => {
    const bytes = webp(1234);
    const res = await json(await upload(bytes, { type: "image/png", name: "x.png" }));
    assert.equal(res.status, 200);
    const p = profileOf();
    assert.match(p.profileImageStorageKey, new RegExp(`^Teachers/${T}/Profile/Photo/[0-9a-f]{32}\\.webp$`));
    assert.equal(p.profileImageMimeType, "image/webp");
    assert.equal(p.profileImageSizeBytes, 1234);
    assert.equal(p.profileImageSha256, sha(bytes));
    assert.ok(fs.readFileSync(keyPath(s, p.profileImageStorageKey)).equals(bytes));
    assert.equal(p.profileImageUrl, `/api/teacher-photos/${T}/${p.profileImageStorageKey.split("/").pop()}`);
    assert.equal(res.body.data.profileImageUrl, p.profileImageUrl);
    assert.ok(!fs.existsSync(path.join(s.app, "storage", "teachers", path.basename(p.profileImageStorageKey))), "nothing inside the application folder");
  });
});

test("keys: strict parsing; another teacher's key is never treated as own", () => {
  const key = K.profilePhotoKey({ teacherId: T, storedName: K.generateProfilePhotoStoredName("image/jpeg") });
  assert.deepEqual(K.ownProfilePhotoKey(key, T)?.teacherId, T);
  assert.equal(K.ownProfilePhotoKey(key, T2), null);
  for (const bad of [`Teachers/${T}/Profile/Photo/../../x.jpg`, `Teachers/${T}/Profile/Photo/${"a".repeat(32)}.svg`, `Teachers/../Profile/Photo/${"a".repeat(32)}.jpg`, `/abs/${"a".repeat(32)}.jpg`, null, 7]) {
    assert.equal(K.parseProfilePhotoKey(bad), null, String(bad));
  }
  assert.throws(() => K.profilePhotoKey({ teacherId: "../x", storedName: `${"a".repeat(32)}.jpg` }));
  assert.equal(K.profilePhotoKeyFromRoute("..", `${"a".repeat(32)}.jpg`), null);
});

test("storage failure: nothing left behind, the reservation released, the previous photo untouched (503)", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(500))).status, 200);
    const before = { ...profileOf() };
    s.setRoot(false);
    const res = await json(await upload(jpeg(700), { type: "image/jpeg" }));
    assert.equal(res.status, 503);
    assert.deepEqual(profileOf(), before);
    assert.deepEqual(db.reservations, []);
    s.setRoot(true);
    assert.deepEqual(filesBelow(s.files), [before.profileImageStorageKey]);
  });
});

// ==== 3. Quota ================================================================================================

test("quota: the photo is its own category (Profile Images) in usage, committed and reserved", async () => {
  await withSandbox(async () => {
    db.otherBytes = { notes: B(1000), submissions: B(50) };
    assert.equal((await upload(png(600))).status, 200);
    const u = await usage();
    assert.equal(u.committed.profileImages, B(600));
    assert.equal(u.committed.total, B(1650));
    db.reservations.push({ id: "r1", teacherId: T, category: "PROFILE_IMAGE", bytes: B(70), storageKey: K.profilePhotoKey({ teacherId: T, storedName: K.generateProfilePhotoStoredName("image/png") }), createdAt: new Date(db.clock), expiresAt: new Date(db.clock + 60_000) });
    assert.equal((await usage()).reserved.profileImages, B(70));
  });
});

test("quota boundary: exactly fitting is accepted; one byte over is 413 STORAGE_QUOTA_EXCEEDED, nothing stored", async () => {
  await withSandbox(async (s) => {
    db.otherBytes = { notes: B(1000), submissions: B(0) };
    db.limits.push({ teacherId: T, limitBytes: B(1400) });
    const over = await json(await upload(png(401)));
    assert.equal(over.status, 413);
    assert.equal(over.body.error.code, "STORAGE_QUOTA_EXCEEDED");
    assert.deepEqual(filesBelow(s.files), []);
    assert.equal((await upload(png(400))).status, 200);
    assert.equal((await usage()).totalUsedAndReservedBytes, B(1400));
  });
});

test("replacement accounting: the FULL new size must fit while the old photo still counts; afterwards only the new one counts", async () => {
  await withSandbox(async (s) => {
    db.limits.push({ teacherId: T, limitBytes: B(1000) });
    assert.equal((await upload(png(600))).status, 200);
    const old = profileOf().profileImageStorageKey;
    assert.equal((await upload(png(401))).status, 413, "600 counted + 401 new > 1000");
    assert.equal(profileOf().profileImageStorageKey, old, "the old photo stays");
    assert.equal((await upload(png(400))).status, 200);
    const u = await usage();
    assert.equal(u.committed.profileImages, B(400));
    assert.equal(u.reserved.total, B(0));
    assert.deepEqual(filesBelow(s.files), [profileOf().profileImageStorageKey], "the old file is deleted after the commit");
  });
});

test("concurrent uploads near the boundary (room for one): exactly one is saved; no reservation or stray file remains", async () => {
  await withSandbox(async (s) => {
    db.limits.push({ teacherId: T, limitBytes: B(700) });
    const results = await Promise.all([upload(png(600)), upload(png(650)), upload(jpeg(620), { type: "image/jpeg" })]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 413, 413]);
    assert.deepEqual(db.reservations, []);
    assert.deepEqual(filesBelow(s.files), [profileOf().profileImageStorageKey]);
    assert.ok((await usage()).committed.total <= B(700));
  });
});

test("concurrent replacements with room for all: one referenced photo at the end; superseded files discarded; usage = that photo", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const results = await Promise.all([upload(png(410)), upload(png(420)), upload(png(430))]);
    for (const r of results) assert.ok([200, 409].includes(r.status), String(r.status));
    assert.ok(results.some((r) => r.status === 200));
    const p = profileOf();
    assert.deepEqual(filesBelow(s.files), [p.profileImageStorageKey], "only the current photo is on disk");
    assert.deepEqual(db.reservations, []);
    assert.equal((await usage()).committed.profileImages, B(p.profileImageSizeBytes));
    assert.ok(db.lockLog.every((k) => k === `storage-quota:teacher:${T}`), "only the teacher quota lock (level 2) is taken");
  });
});

test("compare-and-set: a change committed between the read and the commit makes the attempt retry; nothing is lost", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    let raced = false;
    db.hooks.beforeUpdateMany = async (where) => {
      if (raced || !("profileImageStorageKey" in where) || where.profileImageUrl === null) return;
      raced = true;
      // Another tab removes the photo's URL first (a removal started).
      profileOf().profileImageUrl = null;
    };
    const res = await json(await upload(png(320)));
    assert.equal(res.status, 200);
    assert.ok(raced);
    assert.deepEqual(filesBelow(s.files), [profileOf().profileImageStorageKey]);
  });
});

// ==== 4. Lifecycle ===========================================================================================

test("failed database update: the old photo is kept, the new file discarded, the reservation released", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const before = { ...profileOf() };
    db.hooks.beforeUpdateMany = async () => {
      throw new Error("database down");
    };
    const res = await upload(png(310));
    assert.equal(res.status, 500);
    db.hooks.beforeUpdateMany = null;
    assert.deepEqual(profileOf(), before);
    assert.deepEqual(filesBelow(s.files), [before.profileImageStorageKey]);
    assert.deepEqual(db.reservations, []);
  });
});

test("replacing a LEGACY photo: the legacy file is never deleted; the new photo is on unified storage", async () => {
  await withSandbox(async (s) => {
    const legacyName = `${T}-1700000000000.jpg`;
    const legacyFile = path.join(s.app, "storage", "teachers", legacyName);
    fs.writeFileSync(legacyFile, jpeg());
    db.profiles.push({ id: "p", teacherId: T, slug: "s", profileImageUrl: `/uploads/teachers/${legacyName}`, profileImageStorageKey: null, profileImageSha256: null, profileImageSizeBytes: null, profileImageMimeType: null });
    assert.equal((await upload(png(300))).status, 200);
    assert.ok(fs.existsSync(legacyFile), "legacy file kept");
    assert.ok(profileOf().profileImageStorageKey);
  });
});

test("remove: hidden, file deleted, columns cleared, quota released; repeat is a no-op", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const res = await json(await remove());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { removed: true, pending: false, profileImageUrl: null });
    const p = profileOf();
    assert.deepEqual([p.profileImageUrl, p.profileImageStorageKey, p.profileImageSha256, p.profileImageSizeBytes, p.profileImageMimeType], [null, null, null, null, null]);
    assert.deepEqual(filesBelow(s.files), []);
    assert.equal((await usage()).committed.profileImages, B(0));
    assert.equal((await remove()).status, 200);
    assert.deepEqual((await json(await getOwn())).body, { profileImageUrl: null }, "default avatar: null, the UI shows its placeholder");
  });
});

test("remove with a failed physical deletion: 202 pending (hidden, still counted); maintenance finishes it; backoff after a failure", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const key = profileOf().profileImageStorageKey;
    s.setRoot(false);
    const res = await json(await remove());
    assert.equal(res.status, 202);
    assert.deepEqual(res.body.data, { removed: false, pending: true, profileImageUrl: null });
    assert.equal(profileOf().profileImageUrl, null, "hidden at once");
    assert.equal(profileOf().profileImageStorageKey, key, "still referenced");
    assert.equal((await usage()).committed.profileImages, B(300), "still counted until the file is gone");
    assert.equal((await serve(T, key.split("/").pop())).status, 404, "not served while pending");
    const failed = await PHOTO.finishPendingProfilePhotoRemovals();
    assert.deepEqual([failed.examined, failed.failed], [1, 1]);
    assert.equal((await PHOTO.finishPendingProfilePhotoRemovals()).backoff, 1, "backs off (no log every minute)");
    s.setRoot(true);
    PHOTO.resetProfilePhotoMaintenanceStateForTests();
    const done = await PHOTO.finishPendingProfilePhotoRemovals();
    assert.equal(done.removed, 1);
    assert.equal(profileOf().profileImageStorageKey, null);
    assert.deepEqual(filesBelow(s.files), []);
    assert.equal((await usage()).committed.profileImages, B(0));
  });
});

test("remove a LEGACY photo: the URL is cleared, the legacy file kept", async () => {
  await withSandbox(async (s) => {
    const legacyFile = path.join(s.app, "storage", "teachers", `${T}-1.jpg`);
    fs.writeFileSync(legacyFile, jpeg());
    db.profiles.push({ id: "p", teacherId: T, slug: "s", profileImageUrl: `/uploads/teachers/${T}-1.jpg`, profileImageStorageKey: null, profileImageSha256: null, profileImageSizeBytes: null, profileImageMimeType: null });
    assert.equal((await remove()).status, 200);
    assert.equal(profileOf().profileImageUrl, null);
    assert.ok(fs.existsSync(legacyFile));
  });
});

test("a failed deletion of the REPLACED photo is logged and left for the orphan sweep (not counted, not referenced)", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const old = profileOf().profileImageStorageKey;
    // A directory where the old file should be: strict removal refuses (never a directory delete).
    fs.rmSync(keyPath(s, old));
    fs.mkdirSync(keyPath(s, old));
    assert.equal((await upload(png(310))).status, 200, "the replacement itself succeeds");
    assert.notEqual(profileOf().profileImageStorageKey, old);
    assert.equal((await usage()).committed.profileImages, B(310));
    assert.ok(db.logged.some((l) => l.url === "http://internal/storage/profile-photo"));
    fs.rmdirSync(keyPath(s, old));
  });
});

// ==== 5. Serving =============================================================================================

test("serving: the current photo with its stored type, nosniff, sandbox CSP and immutable caching; old / unknown / malformed names are 404", async () => {
  await withSandbox(async () => {
    const bytes = png(500);
    assert.equal((await upload(bytes)).status, 200);
    const name = profileOf().profileImageStorageKey.split("/").pop();
    const res = await serve(T, name);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));

    assert.equal((await upload(png(510))).status, 200);
    assert.equal((await serve(T, name)).status, 404, "a replaced photo is never served");
    for (const [teacherId, file] of [[T2, profileOf().profileImageStorageKey.split("/").pop()], ["..", name], [T, "../../.env"], [T, "..%2F..%2F.env"], [T, "%2e%2e"], [T, `${"a".repeat(32)}.svg`], [T, "C:\\Windows\\win.ini"], [T, "/etc/passwd"]]) {
      const r = await serve(teacherId, file);
      assert.equal(r.status, 404, `${teacherId} ${file}`);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    }
  });
});

test("legacy route (hardened): old names still served with safe headers; traversal, encodings, SVG, absolute paths and links are 404", async () => {
  await withSandbox(async (s) => {
    const name = `${T}-1700000000000.jpg`;
    fs.writeFileSync(path.join(s.app, "storage", "teachers", name), jpeg());
    fs.writeFileSync(path.join(s.app, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(s.app, "storage", "teachers", `${T}-1.svg`), SVG);
    const ok = await serveLegacy(name);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(ok.headers.get("content-security-policy"), /sandbox/);
    for (const bad of ["../../.env", "..\\..\\.env", "..%2F..%2F.env", "%2e%2e%2f.env", `${T}-1.svg`, "/etc/passwd", "C:\\x.jpg", ".hidden.jpg", "a/b.jpg", "x.jpg\u0000.png", ""]) {
      const r = await serveLegacy(bad);
      assert.equal(r.status, 404, JSON.stringify(bad));
      assert.doesNotMatch(Buffer.from(await r.arrayBuffer()).toString(), /SECRET/);
    }
    // A sibling legacy folder (Notes / submissions) is never reachable through this route.
    fs.mkdirSync(path.join(s.app, "storage", "lectures", "l1"), { recursive: true });
    fs.writeFileSync(path.join(s.app, "storage", "lectures", "l1", "note.jpg"), jpeg());
    for (const sibling of ["../lectures/l1/note.jpg", String.raw`..\lectures\l1\note.jpg`]) assert.equal((await serveLegacy(sibling)).status, 404, sibling);
    // A link inside the folder pointing outside it is never followed.
    const outside = path.join(s.base, "outside.jpg");
    fs.writeFileSync(outside, jpeg());
    try {
      fs.symlinkSync(outside, path.join(s.app, "storage", "teachers", `${T}-2.jpg`));
    } catch {
      return; // links not permitted on this machine: confinement is covered by the shared legacy reader's own tests
    }
    assert.equal((await serveLegacy(`${T}-2.jpg`)).status, 404);
  });
});

// ==== 6. Orphan sweep and inventory ================================================================================

test("orphan sweep: only Teachers/*/Profile/Photo; referenced, reserved, young, unknown and other folders are never touched", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const current = profileOf().profileImageStorageKey;
    const name = () => K.generateProfilePhotoStoredName("image/png");
    const put = (key, ageHours) => {
      const file = keyPath(s, key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, png());
      const t = new Date(Date.now() - ageHours * 3_600_000);
      fs.utimesSync(file, t, t);
      return key;
    };
    const orphan = put(K.profilePhotoKey({ teacherId: T, storedName: name() }), 48);
    const young = put(K.profilePhotoKey({ teacherId: T, storedName: name() }), 1);
    const reserved = put(K.profilePhotoKey({ teacherId: T, storedName: name() }), 48);
    db.reservations.push({ id: "r", teacherId: T, category: "PROFILE_IMAGE", bytes: B(1), storageKey: reserved, createdAt: new Date(db.clock), expiresAt: new Date(Date.now() + 600_000) });
    const otherTeacherOrphan = put(K.profilePhotoKey({ teacherId: T2, storedName: name() }), 48);
    const unknown = put(`Teachers/${T}/Profile/Photo/readme.txt`, 48);
    const note = put(`Teachers/${T}/Lectures/l1/Notes/n1/${"a".repeat(32)}.pdf`, 48);
    const elsewhere = put(`Teachers/${T}/Profile/Other/${"b".repeat(32)}.png`, 48);
    const old = new Date(Date.now() - 48 * 3_600_000);
    fs.utimesSync(keyPath(s, current), old, old);

    const report = await PHOTO.sweepProfilePhotoOrphans();
    assert.equal(report.deleted, 2, JSON.stringify(report));
    assert.equal(report.complete, true);
    const left = filesBelow(s.files);
    for (const k of [current, young, reserved, unknown, note, elsewhere]) assert.ok(left.includes(k), k);
    for (const k of [orphan, otherTeacherOrphan]) assert.ok(!left.includes(k), k);
  });
});

test("inventory: profile photos are recognised as their own feature folder (never unexpected / unreferenced); notes still scanned", async () => {
  await withSandbox(async (s) => {
    assert.equal((await upload(png(300))).status, 200);
    const noteKey = `Teachers/${T}/Lectures/l1/Notes/n1/${"c".repeat(32)}.pdf`;
    fs.mkdirSync(path.dirname(keyPath(s, noteKey)), { recursive: true });
    fs.writeFileSync(keyPath(s, noteKey), "pdf");
    const scan = await INV.scanNewStorage({ storage: path.join(s.app, "storage"), publicUploads: null, fileStorage: s.files });
    assert.deepEqual(scan.files.map((f) => f.relativePath), [noteKey]);
    assert.deepEqual(scan.unexpected, []);
    assert.ok(scan.folders.some((f) => f.relativePath === "fileStorage/Teachers/*/Profile" && f.scanned === false));
  });
});

// ==== 7. Integration and regression (source) =========================================================================

test("maintenance: the existing tick runs pending removals every run and the orphan sweep on its cadence (overlap guard, no new scheduler)", () => {
  const scheduler = code(read("services", "recorded-lecture-maintenance-scheduler.ts"));
  const tick = scheduler.slice(scheduler.indexOf("export async function runMaintenanceTick"), scheduler.indexOf("function newState"));
  assert.ok(tick.indexOf("if (state.running) return null;") < tick.indexOf("finishPendingProfilePhotoRemovals("));
  assert.match(tick, /sweepProfilePhotoOrphans\(\{ deadlineMs: Date\.now\(\) \+ PROFILE_PHOTO_BUDGET_MS \}\)/);
  assert.match(scheduler, /PROFILE_PHOTO_SWEEP_EVERY_MS = 6 \* 3_600_000/);
  const service = code(read("services", "teacher-profile-photo-service.ts"));
  assert.doesNotMatch(service, /setInterval|setTimeout/);
});

test("compatibility: profileImageUrl stays the display URL for the header, public profile, search and the Jitsi photoUrl", () => {
  const profile = code(read("services", "teacher-profile-service.ts"));
  assert.ok((profile.match(/profileImageUrl/g) || []).length >= 4, "profile, public profile and search still return it");
  assert.doesNotMatch(profile, /from "fs"|storage", "teachers"|fs\.unlink|fs\.writeFile/, "the old write / delete-first code is gone");
  assert.match(code(read("services", "session-service.ts")), /photoUrl: session\.class\.teacher\.profile\?\.profileImageUrl \|\| null/);
  assert.match(code(read("components", "teacherProfile", "TeacherProfileHeader.tsx")), /<GraduationCap/, "the default avatar placeholder");
});

test("no administrator photo removal: no admin route or service touches profile photos", () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && /removeTeacherProfilePhoto|profileImageStorageKey/.test(read(...rel.split("/")))) hits.push(rel);
    }
  };
  for (const dir of ["app/api/admin", "components"]) walk(dir);
  assert.deepEqual(hits, []);
  const users = [];
  const walkAll = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walkAll(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && /removeTeacherProfilePhoto\(/.test(code(read(...rel.split("/"))))) users.push(rel);
    }
  };
  for (const dir of ["app", "services"]) walkAll(dir);
  assert.deepEqual(users.sort(), ["app/api/teacher/profile/photo/route.ts", "services/teacher-profile-photo-service.ts"]);
});
