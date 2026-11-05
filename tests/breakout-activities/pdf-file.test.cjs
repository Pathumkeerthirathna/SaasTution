/*
 * Breakout PDFs (lib/breakout-activities/pdf-file.ts): upload checks, display
 * names and storage paths. Nothing here touches the disk.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const f = require(path.join(root, "lib/breakout-activities/pdf-file.ts"));

const SESSION = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const ACTIVITY = "9db014fc-fc1d-434a-853d-6e6909c7a465";
const pdf = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from("%PDF-1.7\n"));
  return bytes;
};

test("magic bytes: %PDF- at offset 0 only", () => {
  assert.equal(f.hasPdfMagic(pdf()), true);
  assert.equal(f.hasPdfMagic(Buffer.from("%PDF-")), true);
  assert.equal(f.hasPdfMagic(Buffer.from(" %PDF-1.7")), false, "leading space");
  assert.equal(f.hasPdfMagic(Buffer.from("\uFEFF%PDF-1.7")), false, "leading BOM");
  assert.equal(f.hasPdfMagic(Buffer.from("%PDF")), false, "too short");
  assert.equal(f.hasPdfMagic(Buffer.from("<html>%PDF-")), false);
  assert.equal(f.hasPdfMagic("%PDF-1.7"), false, "a string is not bytes");
});

test("upload: size boundaries use the real byte length", () => {
  assert.equal(f.MAX_BREAKOUT_PDF_BYTES, 25 * 1024 * 1024);
  assert.deepEqual(f.validatePdfUpload(new Uint8Array(0), "application/pdf"), { ok: false, code: "FILE_EMPTY" });
  assert.deepEqual(f.validatePdfUpload(pdf(f.MAX_BREAKOUT_PDF_BYTES), "application/pdf"), { ok: true });
  assert.deepEqual(f.validatePdfUpload(pdf(f.MAX_BREAKOUT_PDF_BYTES + 1), "application/pdf"), { ok: false, code: "FILE_TOO_LARGE" });
});

test("upload: type and content must both be PDF", () => {
  assert.deepEqual(f.validatePdfUpload(pdf(), "application/pdf"), { ok: true });
  for (const type of ["", "application/x-pdf", "image/png", "text/html", "APPLICATION/PDF"]) {
    assert.deepEqual(f.validatePdfUpload(pdf(), type), { ok: false, code: "FILE_NOT_PDF" }, type);
  }
  assert.deepEqual(f.validatePdfUpload(Buffer.from("MZ\x90\x00 not a pdf"), "application/pdf"), { ok: false, code: "FILE_NOT_PDF" });
});

test("display names: directories, control and bidi characters removed", () => {
  assert.equal(f.sanitizeDisplayName("essay.pdf"), "essay.pdf");
  assert.equal(f.sanitizeDisplayName("../../etc/passwd"), "passwd.pdf");
  assert.equal(f.sanitizeDisplayName("C:\\Users\\amal\\My Essay.PDF"), "My Essay.pdf");
  assert.equal(f.sanitizeDisplayName("bad\u0000name\u001F.pdf"), "badname.pdf");
  assert.equal(f.sanitizeDisplayName("invoice\u202Efdp.exe"), "invoicefdp.exe.pdf", "right-to-left override removed");
  assert.equal(f.sanitizeDisplayName("a\u2066b\u2069.pdf"), "ab.pdf");
  assert.equal(f.sanitizeDisplayName("  many   spaces  .pdf"), "many spaces.pdf");
  assert.equal(f.sanitizeDisplayName(".hidden.pdf"), "hidden.pdf");
  assert.equal(f.sanitizeDisplayName("notes"), "notes.pdf");
  assert.equal(f.sanitizeDisplayName("trailing dots..."), "trailing dots.pdf");
});

test("display names: empty falls back; Sinhala ZWJ is kept", () => {
  for (const v of ["", "   ", ".pdf", "/", "..", null, undefined, 42]) assert.equal(f.sanitizeDisplayName(v), "document.pdf", String(v));
  assert.equal(f.sanitizeDisplayName("", "submission"), "submission.pdf");
  const sinhala = "\u0DBA\u0DB1\u0DCA\u0DAD\u0DCA\u200D\u0DBB";
  assert.equal(f.sanitizeDisplayName(`${sinhala}.pdf`), `${sinhala}.pdf`);
});

test("display names: at most 200 characters (code points), ending in .pdf", () => {
  const long = f.sanitizeDisplayName(`${"x".repeat(500)}.pdf`);
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.endsWith(".pdf"));
  const emoji = f.sanitizeDisplayName("\u{1F600}".repeat(300));
  assert.equal(Array.from(emoji).length, 200, "an emoji is one character, never split");
  assert.ok(emoji.endsWith(".pdf"));
});

test("stored names are server-generated", () => {
  const token = f.randomFileToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.notEqual(token, f.randomFileToken());
  assert.equal(f.generateStoredFileName(1788665952958, token), `1788665952958-${token}.pdf`);
  assert.throws(() => f.generateStoredFileName(1788665952958, "../evil"), RangeError);
  assert.throws(() => f.generateStoredFileName(1788665952958, "ABCDEF0123456789"), RangeError, "uppercase");
  assert.throws(() => f.generateStoredFileName(12, token), RangeError);
});

test("paths: built from validated parts only", () => {
  const storedName = f.generateStoredFileName(1788665952958, "0123456789abcdef");
  assert.equal(
    f.buildBreakoutFilePath({ sessionId: SESSION, kind: "submission", activityId: ACTIVITY, storedName }),
    `breakout-activities/${SESSION}/submissions/${ACTIVITY}/${storedName}`
  );
  assert.equal(
    f.buildBreakoutFilePath({ sessionId: SESSION.toUpperCase(), kind: "brief", activityId: ACTIVITY, storedName }),
    `breakout-activities/${SESSION}/briefs/${ACTIVITY}/${storedName}`
  );
  assert.throws(() => f.buildBreakoutFilePath({ sessionId: "..", kind: "brief", activityId: ACTIVITY, storedName }), RangeError);
  assert.throws(() => f.buildBreakoutFilePath({ sessionId: SESSION, kind: "other", activityId: ACTIVITY, storedName }), RangeError);
  assert.throws(() => f.buildBreakoutFilePath({ sessionId: SESSION, kind: "brief", activityId: ACTIVITY, storedName: "essay.pdf" }), RangeError);
});

test("paths: resolving refuses anything outside the session folder", () => {
  const storageRoot = path.join(root, "storage");
  const storedName = f.generateStoredFileName(1788665952958, "0123456789abcdef");
  const good = `breakout-activities/${SESSION}/submissions/${ACTIVITY}/${storedName}`;
  assert.equal(f.resolveBreakoutFilePath(storageRoot, good, SESSION), path.join(storageRoot, "breakout-activities", SESSION, "submissions", ACTIVITY, storedName));

  const other = "11111111-1111-4111-8111-111111111111";
  const attacks = [
    `breakout-activities/${other}/submissions/${ACTIVITY}/${storedName}`,
    `breakout-activities/${SESSION}/../${other}/submissions/${storedName}`,
    `breakout-activities/${SESSION}/submissions/${ACTIVITY}/../../../../.env`,
    `breakout-activities/${SESSION}/submissions/${ACTIVITY}/..`,
    `assignments/${SESSION}/submissions/${ACTIVITY}/${storedName}`,
    `/etc/passwd`,
    `breakout-activities\\${SESSION}\\submissions\\${ACTIVITY}\\${storedName}`,
    `breakout-activities/${SESSION}/uploads/${ACTIVITY}/${storedName}`,
    "",
  ];
  for (const p of attacks) assert.throws(() => f.resolveBreakoutFilePath(storageRoot, p, SESSION), RangeError, p);
  assert.throws(() => f.resolveBreakoutFilePath(storageRoot, good, "not-a-uuid"), RangeError);
});

test("session folder: only a UUID under breakout-activities", () => {
  const storageRoot = path.join(root, "storage");
  assert.equal(f.resolveBreakoutSessionDir(storageRoot, SESSION), path.join(storageRoot, "breakout-activities", SESSION));
  for (const id of ["..", "", ".", "../assignments", `${SESSION}/..`]) {
    assert.throws(() => f.resolveBreakoutSessionDir(storageRoot, id), RangeError, id);
  }
  assert.throws(() => f.resolveBreakoutSessionDir("", SESSION), RangeError);
});
