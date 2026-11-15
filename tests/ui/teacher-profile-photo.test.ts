/**
 * Teacher profile photo: the browser side (components/teacherProfile/
 * profile-photo-client.ts) and its use in the profile header. Fakes only (a
 * scripted XMLHttpRequest, a fake fetch with real Response objects). No browser.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PROFILE_PHOTO_ACCEPT,
  PROFILE_PHOTO_ENDPOINT,
  photoErrorMessage,
  removeProfilePhotoRequest,
  uploadProfilePhotoRequest,
  validatePhotoUpload,
  validateSelectedPhoto,
  type XhrLike,
} from "../../components/teacherProfile/profile-photo-client";

const ROOT = path.join(__dirname, "..", "..");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeXhr(script: { status: number; body: unknown; progress?: Array<[number, number]>; networkError?: boolean }) {
  const calls: { method?: string; url?: string; body?: FormData } = {};
  const xhr: XhrLike = {
    responseText: "",
    status: 0,
    upload: { onprogress: null },
    onload: null,
    onerror: null,
    onabort: null,
    open(method, url) {
      calls.method = method;
      calls.url = url;
    },
    send(body) {
      calls.body = body;
      for (const [loaded, total] of script.progress ?? []) xhr.upload?.onprogress?.({ lengthComputable: true, loaded, total });
      if (script.networkError) return xhr.onerror?.();
      xhr.status = script.status;
      xhr.responseText = typeof script.body === "string" ? script.body : JSON.stringify(script.body);
      xhr.onload?.();
    },
  };
  return { xhr, calls };
}

test("selection: only JPEG / PNG / WebP; the cropped upload must be 1 byte .. 2 MB", () => {
  assert.equal(PROFILE_PHOTO_ACCEPT, "image/jpeg,image/png,image/webp");
  for (const type of ["image/jpeg", "image/png", "image/webp"]) assert.equal(validateSelectedPhoto({ type }), null);
  for (const type of ["image/svg+xml", "image/gif", "text/html", ""]) assert.match(validateSelectedPhoto({ type }) ?? "", /JPEG, PNG or WebP/);
  assert.equal(validatePhotoUpload({ size: 2 * 1024 * 1024 }), null);
  assert.match(validatePhotoUpload({ size: 2 * 1024 * 1024 + 1 }) ?? "", /larger than 2 MB/);
  assert.match(validatePhotoUpload({ size: 0 }) ?? "", /could not be prepared/);
});

test("upload: PUT multipart 'photo' to the session-scoped endpoint (no teacher id); progress reported; success returns the server URL", async () => {
  const { xhr, calls } = fakeXhr({ status: 200, body: { success: true, data: { profileImageUrl: "/api/teacher-photos/t/abc.png" } }, progress: [[50, 200], [200, 200]] });
  const progress: number[] = [];
  const result = await uploadProfilePhotoRequest(new Blob([new Uint8Array(200)], { type: "image/png" }), { createXhr: () => xhr, onProgress: (p) => progress.push(p), fileName: "profile.png" });
  assert.deepEqual(result, { ok: true, profileImageUrl: "/api/teacher-photos/t/abc.png" });
  assert.deepEqual([calls.method, calls.url], ["PUT", PROFILE_PHOTO_ENDPOINT]);
  assert.equal(PROFILE_PHOTO_ENDPOINT, "/api/teacher/profile/photo");
  assert.ok(calls.body?.get("photo") instanceof Blob);
  assert.deepEqual([...calls.body!.keys()], ["photo"], "nothing else is sent");
  assert.deepEqual(progress, [25, 100]);
});

test("upload errors: quota (server message), too large, wrong type, signed out, network, unreadable answer", async () => {
  const run = (script: Parameters<typeof fakeXhr>[0]) => uploadProfilePhotoRequest(new Blob(["x"]), { createXhr: () => fakeXhr(script).xhr });
  assert.deepEqual(await run({ status: 413, body: { success: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage limit reached: 5 GB of 5 GB used." } } }), { ok: false, message: "Storage limit reached: 5 GB of 5 GB used." });
  assert.match((await run({ status: 413, body: { success: false, error: { code: "PROFILE_PHOTO_TOO_LARGE" } } }) as { message: string }).message, /larger than 2 MB/);
  assert.match((await run({ status: 415, body: { success: false, error: { code: "PROFILE_PHOTO_INVALID_IMAGE" } } }) as { message: string }).message, /JPEG, PNG or WebP/);
  assert.match((await run({ status: 401, body: { success: false } }) as { message: string }).message, /sign in again/);
  assert.match((await run({ status: 0, body: "", networkError: true }) as { message: string }).message, /Network error/);
  assert.equal((await run({ status: 200, body: "<html>" })).ok, false, "never success without the server's URL");
  assert.equal(photoErrorMessage(500, null, "Failed to upload the photo."), "Failed to upload the photo.");
});

test("remove: DELETE (same-origin credentials); removed, pending (202, said so), or an error", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const done = await removeProfilePhotoRequest({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return json(200, { success: true, data: { removed: true, pending: false, profileImageUrl: null } });
    },
  });
  assert.deepEqual(done, { ok: true, pending: false, message: "Profile photo removed." });
  assert.deepEqual([seen[0].url, seen[0].init?.method, seen[0].init?.credentials], [PROFILE_PHOTO_ENDPOINT, "DELETE", "same-origin"]);
  const pending = await removeProfilePhotoRequest({ fetchImpl: async () => json(202, { success: true, data: { removed: false, pending: true } }) });
  assert.equal(pending.ok && pending.pending, true);
  assert.match((pending as { message: string }).message, /still being deleted/);
  assert.equal((await removeProfilePhotoRequest({ fetchImpl: async () => json(403, { success: false, error: { message: "This request must come from the application itself." } }) })).ok, false);
  assert.equal((await removeProfilePhotoRequest({ fetchImpl: async () => { throw new TypeError("offline"); } })).ok, false);
});

test("header: the helpers are used; accept list, progress, inline feedback, remove confirmation; default avatar; no truncation", () => {
  const src = readFileSync(path.join(ROOT, "components", "teacherProfile", "TeacherProfileHeader.tsx"), "utf8");
  assert.match(src, /accept=\{PROFILE_PHOTO_ACCEPT\}/);
  assert.match(src, /uploadProfilePhotoRequest\(croppedBlob/);
  assert.match(src, /onProgress: \(percent\) => setUploadProgress\(percent\)/);
  assert.match(src, /role="progressbar"/);
  assert.match(src, /window\.confirm\("Remove your profile photo\? It will be deleted permanently\."\)/);
  assert.match(src, /removeProfilePhotoRequest\(\)/);
  assert.match(src, /aria-label="Remove profile photo"/);
  assert.match(src, /role=\{photoError \? "alert" : "status"\}/);
  assert.match(src, /<GraduationCap/, "default avatar when there is no photo");
  assert.doesNotMatch(src, /alert\("Failed to upload image\."\)/, "no blocking alert for upload errors");
  const feedback = src.slice(src.indexOf("Profile photo feedback"), src.indexOf("{/* Name */}"));
  assert.doesNotMatch(feedback, /\btruncate\b|line-clamp/);
  assert.match(feedback, /break-words/);
});
