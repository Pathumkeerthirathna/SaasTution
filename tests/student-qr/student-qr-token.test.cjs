/*
 * Unit tests for lib/student-qr-token.ts (pure crypto, no database).
 *
 *   npm run test:student-qr
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const qr = require(path.join(root, "lib", "student-qr-token.ts"));

// Fixed, obviously fake test material (never a real secret).
const SECRET_TEXT = crypto.createHash("sha512").update("student-qr unit test secret").digest("base64");
const SECRET = qr.loadStudentQrSecret({ STUDENT_QR_SECRET: SECRET_TEXT });
const ROW_A = "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f";
const ROW_B = "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e60";
const NONCE_A = Buffer.alloc(32, 7).toString("base64url");
const NONCE_B = Buffer.alloc(32, 8).toString("base64url");

const expectConfigError = (env, problem) =>
  assert.throws(
    () => qr.loadStudentQrSecret(env),
    (error) =>
      error instanceof qr.StudentQrConfigError &&
      error.problem === problem &&
      error.code === "STUDENT_QR_NOT_CONFIGURED" &&
      error.statusCode === 503 &&
      !error.message.includes(env.STUDENT_QR_SECRET || "\0") &&
      !error.detail.includes(env.STUDENT_QR_SECRET || "\0")
  );

// ---------------------------------------------------------------- secret

test("secret: a valid base64 / base64url / hex-text secret loads as >= 32 key bytes", () => {
  assert.ok(SECRET.length >= 32);
  for (const text of [
    crypto.randomBytes(48).toString("base64"),
    crypto.randomBytes(32).toString("base64url"),
    crypto.randomBytes(32).toString("hex"),
  ]) {
    const key = qr.loadStudentQrSecret({ STUDENT_QR_SECRET: text });
    assert.ok(Buffer.isBuffer(key) && key.length >= 32);
  }
  // Surrounding whitespace (e.g. from an .env editor) is ignored.
  assert.deepEqual(qr.loadStudentQrSecret({ STUDENT_QR_SECRET: ` ${SECRET_TEXT}\n` }), SECRET);
});

test("secret: missing or blank configuration fails with a clear server-side error", () => {
  expectConfigError({}, "missing");
  expectConfigError({ STUDENT_QR_SECRET: "" }, "missing");
  expectConfigError({ STUDENT_QR_SECRET: "   " }, "missing");
  const error = (() => {
    try {
      qr.loadStudentQrSecret({});
    } catch (e) {
      return e;
    }
  })();
  assert.match(error.detail, /STUDENT_QR_SECRET is not set/);
});

test("secret: shorter than 32 bytes is rejected", () => {
  expectConfigError({ STUDENT_QR_SECRET: crypto.randomBytes(31).toString("base64") }, "too_short");
  expectConfigError({ STUDENT_QR_SECRET: crypto.randomBytes(16).toString("base64url") }, "too_short");
});

test("secret: non-base64 text and placeholders are rejected", () => {
  expectConfigError({ STUDENT_QR_SECRET: "this is not base64 at all!!!!!!!!!!!!!!!!!!!!!!!" }, "invalid_encoding");
  expectConfigError({ STUDENT_QR_SECRET: "A".repeat(64) }, "low_entropy");
  expectConfigError({ STUDENT_QR_SECRET: "changeme".repeat(8) }, "low_entropy");
});

test("secret: must not reuse JWT_SECRET", () => {
  expectConfigError({ STUDENT_QR_SECRET: SECRET_TEXT, JWT_SECRET: SECRET_TEXT }, "reuses_jwt_secret");
  expectConfigError({ STUDENT_QR_SECRET: SECRET_TEXT, JWT_SECRET: ` ${SECRET_TEXT} ` }, "reuses_jwt_secret");
  const other = crypto.randomBytes(48).toString("base64");
  assert.ok(qr.loadStudentQrSecret({ STUDENT_QR_SECRET: SECRET_TEXT, JWT_SECRET: other }).length >= 32);
});

test("secret: reads process.env by default and never generates a replacement", () => {
  const before = process.env.STUDENT_QR_SECRET;
  try {
    delete process.env.STUDENT_QR_SECRET;
    assert.throws(() => qr.loadStudentQrSecret(), qr.StudentQrConfigError);
    assert.equal(process.env.STUDENT_QR_SECRET, undefined, "nothing was written back");
    process.env.STUDENT_QR_SECRET = SECRET_TEXT;
    assert.deepEqual(qr.loadStudentQrSecret(), SECRET);
  } finally {
    if (before === undefined) delete process.env.STUDENT_QR_SECRET;
    else process.env.STUDENT_QR_SECRET = before;
  }
});

test("derivation refuses a missing or short key buffer", () => {
  for (const bad of [undefined, null, "string-key", Buffer.alloc(31, 1)]) {
    assert.throws(() => qr.deriveStudentQrToken(bad, ROW_A, NONCE_A), qr.StudentQrInputError);
  }
});

// ---------------------------------------------------------------- nonce

test("nonce: 32 random bytes as 43-character base64url, unique per call", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const nonce = qr.generateStudentQrNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(nonce, "base64url").length, 32);
    assert.ok(qr.isValidStudentQrNonce(nonce));
    seen.add(nonce);
  }
  assert.equal(seen.size, 200);
});

test("nonce: invalid formats are rejected (validator and derivation)", () => {
  const bad = [
    undefined,
    null,
    42,
    "",
    NONCE_A.slice(0, 42), // too short
    NONCE_A + "A", // too long
    NONCE_A.slice(0, 42) + "=", // padding
    NONCE_A.slice(0, 42) + "+", // base64, not base64url
    NONCE_A.slice(0, 42) + "/",
    NONCE_A.slice(0, 42) + " ",
    NONCE_A.slice(0, 42) + "B", // non-canonical: trailing bits set
    ` ${NONCE_A}`,
  ];
  for (const nonce of bad) {
    assert.equal(qr.isValidStudentQrNonce(nonce), false, String(nonce));
    assert.throws(() => qr.deriveStudentQrToken(SECRET, ROW_A, nonce), qr.StudentQrInputError);
  }
});

test("row id must be a lowercase uuid (no ':' ambiguity in the derivation message)", () => {
  for (const rowId of ["", "abc", ROW_A.toUpperCase(), `${ROW_A}:x`, `${ROW_A} `, 123, null]) {
    assert.throws(() => qr.deriveStudentQrToken(SECRET, rowId, NONCE_A), qr.StudentQrInputError);
  }
});

// ---------------------------------------------------------------- derivation

test("derivation is deterministic and exactly HMAC-SHA256 over the documented message", () => {
  const t1 = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  const t2 = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  assert.equal(t1, t2);
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`slc-student-qr:v1:${ROW_A}:${NONCE_A}`)
    .digest("base64url");
  assert.equal(t1, expected);
  // Same secret text loaded twice gives the same tokens (restart-stable).
  const reloaded = qr.loadStudentQrSecret({ STUDENT_QR_SECRET: SECRET_TEXT });
  assert.equal(qr.deriveStudentQrToken(reloaded, ROW_A, NONCE_A), t1);
});

test("different row ids, nonces or secrets give different tokens", () => {
  const base = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  assert.notEqual(qr.deriveStudentQrToken(SECRET, ROW_B, NONCE_A), base);
  assert.notEqual(qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_B), base);
  const otherSecret = qr.loadStudentQrSecret({ STUDENT_QR_SECRET: crypto.randomBytes(48).toString("base64") });
  assert.notEqual(qr.deriveStudentQrToken(otherSecret, ROW_A, NONCE_A), base);
});

// ---------------------------------------------------------------- hashing

test("token hash is SHA-256 lowercase hex (64 chars) and matches the migration CHECK", () => {
  const token = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  const hash = qr.hashStudentQrToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.ok(qr.isValidStudentQrTokenHash(hash));
  assert.notEqual(hash, token);
  assert.notEqual(qr.hashStudentQrToken(qr.deriveStudentQrToken(SECRET, ROW_B, NONCE_A)), hash);
});

test("hashing / payload building reject malformed tokens", () => {
  for (const bad of ["", "short", NONCE_A + "x", 42, null, NONCE_A.slice(0, 42) + "B"]) {
    assert.throws(() => qr.hashStudentQrToken(bad), qr.StudentQrInputError);
    assert.throws(() => qr.buildStudentQrPayload(bad), qr.StudentQrInputError);
  }
});

// ---------------------------------------------------------------- payload

test("payload is SLCQR1:<43-char token> and round-trips through the parser", () => {
  const token = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  const payload = qr.buildStudentQrPayload(token);
  assert.equal(payload, `SLCQR1:${token}`);
  assert.equal(payload.length, 50);
  assert.equal(qr.parseStudentQrPayload(payload), token);
  assert.ok(!payload.includes(ROW_A) && !payload.includes(NONCE_A), "no row id or nonce in the QR");
});

test("payload: wrong or missing prefix is rejected", () => {
  const token = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  for (const payload of [
    token,
    `slcqr1:${token}`,
    `SLCQR2:${token}`,
    `SLCQR1-${token}`,
    `SLCQR1:${token}`.replace("SLCQR1:", "SLCQR1 :").slice(0, 50),
    `XSLCQR1:${token}`.slice(0, 50),
    `https://example.com/?t=${token}`,
  ]) {
    assert.equal(qr.parseStudentQrPayload(payload), null, payload);
  }
});

test("payload: wrong length, characters, whitespace or non-strings are rejected", () => {
  const token = qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A);
  const body = token.slice(0, 42);
  for (const payload of [
    "",
    "SLCQR1:",
    `SLCQR1:${body}`, // 42 chars
    `SLCQR1:${token}A`, // 44 chars
    `SLCQR1:${token} `,
    ` SLCQR1:${token}`,
    `SLCQR1:${token}\n`,
    `SLCQR1:${body}=`,
    `SLCQR1:${body}+`,
    `SLCQR1:${body}/`,
    `SLCQR1:${body}.`,
    `SLCQR1:${body}é`,
    `SLCQR1:${body}B`, // non-canonical base64url
    "SLCQR1:" + "x".repeat(10000),
    undefined,
    null,
    42,
    { toString: () => `SLCQR1:${token}` },
    [`SLCQR1:${token}`],
  ]) {
    assert.equal(qr.parseStudentQrPayload(payload), null, String(payload).slice(0, 60));
  }
});

// ---------------------------------------------------------------- comparison

test("hash comparison is constant-time (timingSafeEqual) and fails closed", () => {
  const h1 = qr.hashStudentQrToken(qr.deriveStudentQrToken(SECRET, ROW_A, NONCE_A));
  const h2 = qr.hashStudentQrToken(qr.deriveStudentQrToken(SECRET, ROW_B, NONCE_A));
  assert.equal(qr.studentQrTokenHashesEqual(h1, h1), true);
  assert.equal(qr.studentQrTokenHashesEqual(h1, `${h1}`), true);
  assert.equal(qr.studentQrTokenHashesEqual(h1, h2), false);
  // Differs only in the last character.
  const last = h1.at(-1) === "0" ? "1" : "0";
  assert.equal(qr.studentQrTokenHashesEqual(h1, h1.slice(0, 63) + last), false);
  // Malformed input never throws and never matches.
  for (const bad of [undefined, null, "", h1.toUpperCase(), h1.slice(0, 63), `${h1}0`, 42]) {
    assert.equal(qr.studentQrTokenHashesEqual(h1, bad), false);
    assert.equal(qr.studentQrTokenHashesEqual(bad, h1), false);
  }
  assert.equal(qr.studentQrTokenHashesEqual(undefined, undefined), false);

  // It really delegates to crypto.timingSafeEqual.
  const original = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    qr.studentQrTokenHashesEqual(h1, h2);
  } finally {
    crypto.timingSafeEqual = original;
  }
  const source = fs.readFileSync(path.join(root, "lib", "student-qr-token.ts"), "utf8");
  assert.match(source, /timingSafeEqual\(Buffer\.from\(a, "hex"\), Buffer\.from\(b, "hex"\)\)/);
  assert.equal(calls, 1);
});

test("stored-row verification returns the token on a match and null after a secret change (no reissue)", () => {
  const nonce = qr.generateStudentQrNonce();
  const token = qr.deriveStudentQrToken(SECRET, ROW_A, nonce);
  const row = { id: ROW_A, nonce, tokenHash: qr.hashStudentQrToken(token) };
  assert.equal(qr.deriveVerifiedStudentQrToken(SECRET, row), token);

  const rotated = qr.loadStudentQrSecret({ STUDENT_QR_SECRET: crypto.randomBytes(48).toString("base64") });
  assert.equal(qr.deriveVerifiedStudentQrToken(rotated, row), null);
  assert.equal(qr.deriveVerifiedStudentQrToken(SECRET, { ...row, tokenHash: "0".repeat(64) }), null);
  assert.equal(row.tokenHash, qr.hashStudentQrToken(token), "the row was not modified");
});

// ---------------------------------------------------------------- hygiene

test("module hygiene: no logging, no DB, no env writes, not imported by client code", () => {
  const source = fs.readFileSync(path.join(root, "lib", "student-qr-token.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /console\.|logger|logError/);
  assert.doesNotMatch(code, /prisma|@\/lib\/prisma|fetch\(/i);
  assert.doesNotMatch(code, /process\.env\.[A-Z_]+\s*=(?!=)/);
  assert.doesNotMatch(code, /NEXT_PUBLIC_/);
  assert.match(code, /typeof window !== "undefined"/);

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (/^\s*["']use client["']/.test(text) && /student-qr-token/.test(text)) offenders.push(full);
      }
    }
  };
  for (const dir of ["app", "components", "lib", "hooks"]) {
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(offenders, []);
});

test("errors never echo secret material", () => {
  const secretText = crypto.randomBytes(16).toString("base64");
  try {
    qr.loadStudentQrSecret({ STUDENT_QR_SECRET: secretText });
    assert.fail("expected an error");
  } catch (error) {
    assert.ok(!String(error.message).includes(secretText));
    assert.ok(!String(error.detail).includes(secretText));
    assert.ok(!String(error.stack).includes(secretText));
  }
  try {
    qr.deriveStudentQrToken(SECRET, ROW_A, "bad-nonce-value");
    assert.fail("expected an error");
  } catch (error) {
    assert.ok(!String(error.message).includes("bad-nonce-value"));
    assert.ok(!String(error.message).includes(ROW_A));
  }
});
