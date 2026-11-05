/*
 * Size-capped request bodies (lib/breakout-activities/request-body.ts):
 * Content-Length refused before reading, streamed bodies cut off at the cap
 * (also without Content-Length), strict multipart fields, and PDF checks
 * from the bytes. Uses real Request objects; nothing is sent anywhere.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const body = require(path.join(root, "lib/breakout-activities/request-body.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const MiB = 1024 * 1024;
const pdfBytes = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from("%PDF-1.7\n"));
  return bytes;
};
const appError = (status, code) => (e) => {
  assert.ok(e instanceof AppError, String(e));
  assert.equal(e.statusCode, status);
  assert.equal(e.code, code);
  return true;
};

/** A request whose body arrives in chunks and counts how much was pulled. */
function streamingRequest(chunks, headers = {}) {
  let pulled = 0;
  // highWaterMark 0: a chunk is produced only when the code under test reads.
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (pulled >= chunks.length) return controller.close();
        controller.enqueue(chunks[pulled++]);
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half", headers });
  return { request, pulled: () => pulled };
}

const multipart = (fill) => {
  const form = new FormData();
  fill(form);
  return new Request("http://localhost/x", { method: "POST", body: form });
};

test("limits: multipart = the PDF limit + 1 MiB; JSON = 8 MiB", () => {
  assert.equal(body.MAX_MULTIPART_BODY_BYTES, 25 * MiB + MiB);
  assert.equal(body.MAX_JSON_BODY_BYTES, 8 * MiB);
});

test("declared Content-Length over the cap: refused before a byte is read", async () => {
  const { request, pulled } = streamingRequest([new Uint8Array(10)], { "content-length": String(27 * MiB) });
  await assert.rejects(body.readBodyWithLimit(request, 26 * MiB, () => new Error("too large")), /too large/);
  assert.equal(pulled(), 0);
});

test("no Content-Length: reading stops at the first chunk past the cap", async () => {
  const chunks = Array.from({ length: 10 }, () => new Uint8Array(1024));
  const { request, pulled } = streamingRequest(chunks);
  await assert.rejects(body.readBodyWithLimit(request, 3000, () => new Error("too large")), /too large/);
  assert.ok(pulled() <= 4, `pulled ${pulled()} chunks`);
});

test("within the cap: the exact bytes; an empty body is empty", async () => {
  const { request } = streamingRequest([Uint8Array.from([1, 2]), Uint8Array.from([3])]);
  assert.deepEqual(await body.readBodyWithLimit(request, 3, () => new Error("x")), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(await body.readBodyWithLimit(new Request("http://localhost/x", { method: "POST" }), 0, () => new Error("x")), new Uint8Array(0));
});

test("a malformed Content-Length is a validation error", async () => {
  const { request } = streamingRequest([new Uint8Array(1)], { "content-length": "1e9" });
  await assert.rejects(body.readBodyWithLimit(request, 10, () => new Error("x")), appError(400, "VALIDATION_ERROR"));
});

test("JSON: application/json only; parsed; over the cap 400; malformed is the usual SyntaxError (400 INVALID_JSON)", async () => {
  const json = (text, type = "application/json") => new Request("http://localhost/x", { method: "POST", body: text, headers: { "content-type": type } });
  assert.deepEqual(await body.readJsonBody(json('{"action":"publish"}')), { action: "publish" });
  assert.deepEqual(await body.readJsonBody(json('{"a":1}', "application/json; charset=utf-8")), { a: 1 });
  await assert.rejects(body.readJsonBody(json('{"a":1}', "text/plain")), appError(400, "VALIDATION_ERROR"));
  await assert.rejects(body.readJsonBody(json("{not json")), SyntaxError);
  await assert.rejects(body.readJsonBody(json("")), SyntaxError);
  await assert.rejects(body.readJsonBody(json(JSON.stringify({ x: "y".repeat(100) })), 50), appError(400, "VALIDATION_ERROR"));
});

test("multipart: parsed after the cap; over the cap 413 FILE_TOO_LARGE; wrong type 400", async () => {
  const form = await body.readMultipartBody(multipart((f) => f.append("title", "Essay")));
  assert.equal(form.get("title"), "Essay");
  await assert.rejects(
    body.readMultipartBody(multipart((f) => f.append("title", "x".repeat(2000))), 1000),
    appError(413, "FILE_TOO_LARGE")
  );
  const notMultipart = new Request("http://localhost/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  await assert.rejects(body.readMultipartBody(notMultipart), appError(400, "VALIDATION_ERROR"));
  const broken = new Request("http://localhost/x", { method: "POST", body: "garbage", headers: { "content-type": "multipart/form-data; boundary=zzz" } });
  await assert.rejects(body.readMultipartBody(broken), appError(400, "VALIDATION_ERROR"));
});

test("form fields: strict names, no duplicates, text vs file, booleans, JSON", async () => {
  const form = await body.readMultipartBody(
    multipart((f) => {
      f.append("title", "Essay");
      f.append("publish", "true");
      f.append("targets", '[{"type":"MAIN"}]');
      f.append("twice", "1");
      f.append("twice", "2");
      f.append("brief", new Blob([pdfBytes()], { type: "application/pdf" }), "brief.pdf");
    })
  );
  assert.throws(() => body.assertOnlyFormFields(form, ["title", "publish", "targets", "brief"]), appError(400, "VALIDATION_ERROR"));
  body.assertOnlyFormFields(form, ["title", "publish", "targets", "brief", "twice"]);
  assert.equal(body.formText(form, "title"), "Essay");
  assert.equal(body.formText(form, "absent"), undefined);
  assert.throws(() => body.formText(form, "twice"), appError(400, "VALIDATION_ERROR"));
  assert.throws(() => body.formText(form, "brief"), appError(400, "VALIDATION_ERROR"), "a file is not text");
  assert.equal(body.formBoolean(form, "publish"), true);
  assert.throws(() => body.formBoolean(form, "title"), appError(400, "VALIDATION_ERROR"));
  assert.deepEqual(body.formJson(form, "targets"), [{ type: "MAIN" }]);
  assert.throws(() => body.formJson(form, "title"), appError(400, "VALIDATION_ERROR"));
  assert.equal(body.formBoolean(form, "absent"), undefined);
});

test("PDF field: checked from its bytes; display name sanitized; empty file input is absent", async () => {
  const form = await body.readMultipartBody(
    multipart((f) => {
      f.append("brief", new Blob([pdfBytes(100)], { type: "application/pdf" }), "../../Essay‮.pdf");
      f.append("html", new Blob(["<html>"], { type: "application/pdf" }), "fake.pdf");
      f.append("wrongType", new Blob([pdfBytes()], { type: "text/html" }), "x.pdf");
      f.append("empty", new Blob([], { type: "application/pdf" }), "empty.pdf");
      f.append("none", new Blob([], { type: "application/octet-stream" }), "");
      f.append("blank", "");
      f.append("text", "not a file");
    })
  );
  const pdf = await body.formPdf(form, "brief");
  assert.equal(pdf.sizeBytes, 100);
  assert.equal(pdf.displayName, "Essay.pdf");
  assert.deepEqual(pdf.bytes, pdfBytes(100));
  await assert.rejects(body.formPdf(form, "html"), appError(400, "INVALID_PDF"));
  await assert.rejects(body.formPdf(form, "wrongType"), appError(400, "INVALID_PDF"));
  await assert.rejects(body.formPdf(form, "empty"), appError(400, "INVALID_PDF"), "a named empty file is invalid");
  assert.equal(await body.formPdf(form, "none"), null, "an empty file input is no file");
  assert.equal(await body.formPdf(form, "blank"), null, "parsed as an empty text value: no file");
  assert.equal(await body.formPdf(form, "absent"), null);
  await assert.rejects(body.formPdf(form, "text"), appError(400, "VALIDATION_ERROR"));
});

test("PDF field over 25 MiB: 413 before its bytes are read", async () => {
  const big = new Uint8Array(25 * MiB + 1);
  big.set(Buffer.from("%PDF-1.7"));
  const form = new FormData();
  form.append("brief", new Blob([big], { type: "application/pdf" }), "big.pdf");
  await assert.rejects(body.formPdf(form, "brief"), appError(413, "FILE_TOO_LARGE"));
});
