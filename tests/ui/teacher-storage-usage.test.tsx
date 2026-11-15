/**
 * Teacher storage quota, Stage 3.5: the teacher's Storage usage card on the
 * dashboard Overview (components/dashboard/dashboard-storage-usage.tsx).
 * Views render with react-dom/server; the loader runs over a fake fetch with
 * real Response objects. No browser, no server.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  StorageUsageError,
  StorageUsageLoading,
  StorageUsageView,
  TEACHER_STORAGE_ENDPOINT,
  limitSourceText,
  loadTeacherStorageView,
} from "../../components/dashboard/dashboard-storage-usage";
import type { TeacherStorageView } from "../../lib/storage-quota/teacher-view";

const ROOT = path.join(__dirname, "..", "..");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const cat = (c: string, r: string, t: string) => ({ committedBytes: c, reservedBytes: r, totalBytes: t });
function view(over: Partial<TeacherStorageView> = {}): TeacherStorageView {
  return {
    measuredAt: "2026-11-16T12:00:00.000Z",
    categories: {
      recordedLectures: cat("3000000000", "500000000", "3500000000"),
      notes: cat("250000000", "0", "250000000"),
      submissions: cat("125000000", "25000000", "150000000"),
      profileImages: cat("0", "0", "0"),
    },
    committedBytes: "3375000000",
    reservedBytes: "525000000",
    totalBytes: "3900000000",
    limitBytes: "10000000000",
    limitSource: "PLAN",
    isUnlimited: false,
    remainingBytes: "6100000000",
    usagePercent: 39,
    isOverQuota: false,
    overQuotaBytes: "0",
    isOverLimitIncludingReservations: false,
    ...over,
  };
}
const render = (v: TeacherStorageView) => renderToStaticMarkup(<StorageUsageView view={v} onRefresh={() => {}} />);

test("loading state", () => {
  const html = renderToStaticMarkup(<StorageUsageLoading />);
  assert.match(html, /role="status"/);
  assert.match(text(html), /Storage usage Loading storage usage/);
});

test("error state with retry", () => {
  const html = renderToStaticMarkup(<StorageUsageError message="Couldn't load your storage usage." onRetry={() => {}} />);
  assert.match(html, /role="alert"/);
  assert.match(text(html), /Couldn't load your storage usage\. Try again/);
});

test("normal state: used (stored + uploading), allocated, remaining, percentage, progress bar, source", () => {
  const html = render(view());
  const t = text(html);
  assert.match(t, /Within quota/);
  assert.match(t, /Your storage limit comes from your subscription plan\./);
  assert.match(t, /3\.9 GB of 10 GB used \(39%\)/);
  assert.match(t, /Used 3\.9 GB 3\.37 GB stored \+ 525 MB uploading/);
  assert.match(t, /Allocated 10 GB/);
  assert.match(t, /Remaining 6\.1 GB/);
  assert.match(t, /Used \(%\) 39%/);
  assert.match(t, /Uploads in progress reserve their full size/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="39"/);
  assert.match(html, /width:39%/);
});

test("category breakdown: stored, uploading and total for each of the three categories", () => {
  const t = text(render(view()));
  assert.match(t, /Category Stored Uploading Total/);
  assert.match(t, /Recorded Lectures 3 GB 500 MB 3\.5 GB/);
  assert.match(t, /Notes & Materials 250 MB 0 bytes 250 MB/);
  assert.match(t, /Student Submissions 125 MB 25 MB 150 MB/);
  assert.match(t, /Profile Images 0 bytes 0 bytes 0 bytes/, "the fourth category, shown separately");
  const withPhoto = text(render(view({ categories: { ...view().categories, profileImages: cat("1500000", "200000", "1700000") } })));
  assert.match(withPhoto, /Profile Images 1\.5 MB 200 KB 1\.7 MB/);
});

test("unlimited: 'Unlimited storage', usage and categories still shown, no remaining / percentage / bar", () => {
  const html = render(view({ limitBytes: null, limitSource: "UNLIMITED_PLAN", isUnlimited: true, remainingBytes: null, usagePercent: null, overQuotaBytes: null }));
  const t = text(html);
  assert.match(t, /Unlimited storage/);
  assert.match(t, /Allocated Unlimited/);
  assert.match(t, /Used 3\.9 GB/);
  assert.match(t, /Recorded Lectures 3 GB/);
  assert.doesNotMatch(t, /Remaining|Used \(%\)|of .* used/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.equal(limitSourceText("NO_ACTIVE_SUBSCRIPTION"), "No storage limit applies to your account.");
});

test("over quota: warning, by how much, uploads may be rejected, files are NOT deleted", () => {
  const html = render(view({ committedBytes: "1500000000", reservedBytes: "0", totalBytes: "1500000000", limitBytes: "1000000000", limitSource: "INDIVIDUAL", remainingBytes: "0", usagePercent: 150, isOverQuota: true, overQuotaBytes: "500000000", isOverLimitIncludingReservations: true }));
  const t = text(html);
  assert.match(t, /Over quota/);
  assert.match(t, /Your storage limit was set by an administrator\./);
  assert.match(t, /Your stored files are 500 MB over your storage limit\. New uploads may be rejected until you free up storage or an administrator increases your limit\. Your existing files stay available\./);
  assert.doesNotMatch(t, /will be deleted|deleted automatically/);
  assert.match(html, /width:100%/, "the bar is capped");
  assert.match(html, /bg-rose-500/);
});

test("limit reached by uploads in progress (stored files within the limit): a softer notice", () => {
  const t = text(render(view({ totalBytes: "10000000001", remainingBytes: "0", usagePercent: 100, isOverLimitIncludingReservations: true })));
  assert.match(t, /Limit reached/);
  assert.match(t, /until an upload finishes or is cancelled/);
  assert.doesNotMatch(t, /Over quota/);
});

test("zero usage: an explanatory empty state instead of an empty table; 0 limit shows no percentage", () => {
  const zero = view({ categories: { recordedLectures: cat("0", "0", "0"), notes: cat("0", "0", "0"), submissions: cat("0", "0", "0"), profileImages: cat("0", "0", "0") }, committedBytes: "0", reservedBytes: "0", totalBytes: "0", remainingBytes: "10000000000", usagePercent: 0 });
  const t = text(render(zero));
  assert.match(t, /You have no stored recordings, notes, student submissions or profile images yet\./);
  assert.match(t, /Used 0 bytes All stored/);
  assert.doesNotMatch(t, /Category Stored/);
  const none = text(render(view({ ...zero, limitBytes: "0", remainingBytes: "0", usagePercent: null })));
  assert.match(none, /Used \(%\) — No storage is allocated\./);
});

test("read only: no input, form, select or limit control - only a Refresh button", () => {
  for (const v of [view(), view({ isUnlimited: true, limitBytes: null, remainingBytes: null, usagePercent: null }), view({ isOverQuota: true, overQuotaBytes: "1" })]) {
    const html = render(v);
    assert.doesNotMatch(html, /<input|<form|<select|<textarea/);
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    assert.deepEqual(buttons.map((b) => text(b).trim()), ["Refresh"]);
  }
});

test("responsive: stacked figures on phones, 2 / 4 columns on larger screens; nothing hidden or truncated", () => {
  const html = render(view());
  assert.match(html, /grid-cols-1 gap-2\.5 sm:grid-cols-2 lg:grid-cols-4/);
  assert.match(html, /break-words/);
  assert.match(html, /class="whitespace-nowrap/, "sizes do not wrap mid-value; category names may");
  const src = readFileSync(path.join(ROOT, "components", "dashboard", "dashboard-storage-usage.tsx"), "utf8");
  assert.doesNotMatch(src, /\btruncate\b|line-clamp|hidden sm:|hidden md:|hidden lg:/);
});

test("loader: GET the session-scoped endpoint (no teacher id sent), same-origin, no-store; errors become messages", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const ok = await loadTeacherStorageView({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(200, { success: true, data: view() });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, TEACHER_STORAGE_ENDPOINT);
  assert.equal(TEACHER_STORAGE_ENDPOINT, "/api/teacher/storage");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.deepEqual(await loadTeacherStorageView({ fetchImpl: async () => json(401, { success: false, error: { message: "Authentication required.", code: "UNAUTHORIZED" } }) }), { ok: false, message: "Authentication required." });
  assert.equal((await loadTeacherStorageView({ fetchImpl: async () => { throw new TypeError("offline"); } })).ok, false);
  assert.deepEqual(await loadTeacherStorageView({ fetchImpl: async () => new Response("<html>", { status: 502 }) }), { ok: false, message: "Couldn't load your storage usage." });
});

test("the card is on the teacher dashboard Overview; the admin Storage card is not reused there", () => {
  const page = readFileSync(path.join(ROOT, "app", "dashboard", "page.tsx"), "utf8");
  assert.match(page, /import \{ DashboardStorageUsage \} from "@\/components\/dashboard\/dashboard-storage-usage";/);
  assert.match(page, /<DashboardStorageUsage \/>/);
  const card = readFileSync(path.join(ROOT, "components", "dashboard", "dashboard-storage-usage.tsx"), "utf8");
  assert.doesNotMatch(card, /admin-teacher-storage-card|\/api\/admin\//);
});
