/**
 * Teacher storage quota, Stage 3.4: the admin Storage card
 * (components/admin-teacher-storage-card.tsx) inside the admin teacher detail
 * panel. Views render with react-dom/server; loaders run over a fake fetch
 * with real Response objects. No browser, no server.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CategoryBreakdown,
  LimitEditor,
  ReductionConfirm,
  StorageErrorView,
  StorageHistoryList,
  StorageLoadingView,
  StorageOverview,
  isReductionBelowUsage,
  limitAfterRemovingOverride,
  limitSourceLabel,
  loadStorageHistory,
  loadTeacherStorage,
  saveStorageLimit,
  storageEndpoint,
  storageLimitEndpoint,
  type AdminStorageSummary,
} from "../../components/admin-teacher-storage-card";
import { bytesToGbInput, formatStorageBytes, parseStorageLimitGb, parseStorageLimitRequest } from "../../lib/storage-quota/limit-input";

const ROOT = path.join(__dirname, "..", "..");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const T1 = "11111111-1111-4111-8111-111111111111";

function summary(over: Partial<AdminStorageSummary["usage"]> = {}, rest: Partial<AdminStorageSummary> = {}): AdminStorageSummary {
  return {
    teacher: { id: T1, name: "Nimal Perera", email: "nimal@example.test" },
    usage: {
      teacherId: T1,
      measuredAt: "2026-11-16T12:00:00.000Z",
      committedBytes: { recordedLectures: "3000000000", notes: "250000000", submissions: "125000000", total: "3375000000" },
      reservedBytes: { recordedLectures: "500000000", notes: "0", submissions: "25000000", total: "525000000" },
      totalUsedAndReservedBytes: "3900000000",
      limit: { limitBytes: "10000000000", source: "PLAN", overrideBytes: null, planLimitBytes: "10000000000" },
      isUnlimited: false,
      remainingBytes: "6100000000",
      usagePercent: 39,
      isOverQuota: false,
      overQuotaBytes: "0",
      ...over,
    },
    isOverLimitIncludingReservations: false,
    override: null,
    subscription: {
      active: { subscriptionId: "s1", status: "ACTIVE", endDate: null, planId: "p1", planName: "Pro", planStorageGB: 10, planLimitBytes: "10000000000" },
      latest: { subscriptionId: "s1", status: "ACTIVE", endDate: null, planId: "p1", planName: "Pro", planStorageGB: 10, planLimitBytes: "10000000000" },
    },
    ...rest,
  };
}

// ---- Views --------------------------------------------------------------------------------------------

test("loading and error states", () => {
  assert.match(text(renderToStaticMarkup(<StorageLoadingView />)), /Loading storage usage/);
  const error = renderToStaticMarkup(<StorageErrorView message="Admin privileges are required." onRetry={() => {}} />);
  assert.match(error, /role="alert"/);
  assert.match(text(error), /Admin privileges are required\. Try again/);
});

test("overview: stored, reserved, total, limit, remaining, percentage and the limit source (decimal units)", () => {
  const t = text(renderToStaticMarkup(<StorageOverview summary={summary()} />));
  for (const expected of ["Within limit", "Limit source: Subscription plan", "Stored 3.37 GB", "Reserved by uploads in progress 525 MB", "Total (stored + reserved) 3.9 GB", "Allocated limit 10 GB", "Remaining 6.1 GB", "Used 39%"]) {
    assert.ok(t.includes(expected), expected);
  }
});

test("category breakdown: committed and reserved for the three categories", () => {
  const t = text(renderToStaticMarkup(<CategoryBreakdown summary={summary()} />));
  assert.match(t, /Recorded Lectures Stored: 3 GB Reserved: 500 MB/);
  assert.match(t, /Notes & Materials Stored: 250 MB Reserved: 0 bytes/);
  assert.match(t, /Student Submissions Stored: 125 MB Reserved: 25 MB/);
});

test("unlimited state: no bar, 'Unlimited' limit and remaining, the plan's explanation", () => {
  const unlimited = summary(
    { limit: { limitBytes: null, source: "UNLIMITED_PLAN", overrideBytes: null, planLimitBytes: null }, isUnlimited: true, remainingBytes: null, usagePercent: null, overQuotaBytes: null },
    {}
  );
  const html = renderToStaticMarkup(<StorageOverview summary={unlimited} />);
  const t = text(html);
  assert.match(t, /Unlimited Limit source: Unlimited \(the subscription plan has no storage limit\)/);
  assert.match(t, /Allocated limit Unlimited/);
  assert.match(t, /Remaining Unlimited/);
  assert.doesNotMatch(html, /rounded-full bg-brand-600/, "no usage bar");
  assert.equal(limitSourceLabel("NO_ACTIVE_SUBSCRIPTION"), "Unlimited (no active subscription)");
});

test("over-limit state: badge, red bar capped at 100%, and the explanation that files are kept", () => {
  const over = summary({ committedBytes: { recordedLectures: "12000000000", notes: "0", submissions: "0", total: "12000000000" }, totalUsedAndReservedBytes: "12000000000", remainingBytes: "0", usagePercent: 120, isOverQuota: true, overQuotaBytes: "2000000000" }, { isOverLimitIncludingReservations: true });
  const html = renderToStaticMarkup(<StorageOverview summary={over} />);
  assert.match(text(html), /Over limit/);
  assert.match(html, /width:100%/);
  assert.match(text(html), /Stored files exceed the limit by 2 GB\. Existing files are kept; new uploads are refused until usage is below the limit\./);
});

test("limit editor: plan allocation, individual limit, labelled input, remove button only when an override exists", () => {
  const props = { value: "", error: null, saving: false, onChange: () => {}, onSave: () => {}, onRemove: () => {} };
  let html = renderToStaticMarkup(<LimitEditor summary={summary()} {...props} />);
  assert.match(text(html), /Subscription plan: Pro: 10 GB/);
  assert.match(text(html), /Individual limit: not set \(the plan applies\)/);
  assert.match(html, /<label[^>]*for="admin-storage-limit-gb"/);
  assert.doesNotMatch(text(html), /Remove individual limit/);
  html = renderToStaticMarkup(
    <LimitEditor summary={summary({}, { override: { limitBytes: "12500000000", updatedAt: "2026-11-16T12:00:00.000Z", updatedByAdminEmail: "admin@example.test" } })} {...props} value="12.5" error="The limit cannot be negative." />
  );
  assert.match(text(html), /Individual limit: 12.5 GB \(set by admin@example.test\)/);
  assert.match(text(html), /Remove individual limit/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /role="alert"[^>]*>The limit cannot be negative\./);

  const ended = summary({}, { subscription: { active: null, latest: { subscriptionId: "s", status: "SUSPENDED", endDate: null, planId: "p", planName: "Pro", planStorageGB: 10, planLimitBytes: "10000000000" } } });
  assert.match(text(renderToStaticMarkup(<LimitEditor summary={ended} {...props} />)), /Subscription plan: Pro \(suspended\): no plan limit applies/);
});

test("reduced-limit confirmation: the three consequences are stated", () => {
  const t = text(renderToStaticMarkup(<ReductionConfirm summary={summary()} newLimitBytes={BigInt(1_000_000_000)} saving={false} onConfirm={() => {}} onCancel={() => {}} />));
  assert.match(t, /Set the limit to 1 GB, below the current usage of 3.9 GB\?/);
  assert.match(t, /Existing files will not be deleted\./);
  assert.match(t, /The teacher may immediately be over the limit\./);
  assert.match(t, /New uploads will be refused until storage usage falls below the new limit\./);
});

test("confirmation decisions: a reduction below current usage (incl. reservations) needs it; removing the override too when the plan is lower", () => {
  const s = summary();
  assert.equal(isReductionBelowUsage(s, BigInt("3899999999")), true);
  assert.equal(isReductionBelowUsage(s, BigInt("3900000000")), false, "exactly the usage is not below it");
  assert.equal(limitAfterRemovingOverride(s), BigInt(10_000_000_000));
  assert.equal(limitAfterRemovingOverride(summary({}, { subscription: { active: null, latest: null } })), null, "no active plan: unlimited");
});

test("history: previous -> new, the administrator and the time; empty history", () => {
  const t = text(
    renderToStaticMarkup(
      <StorageHistoryList
        items={[{ id: "c1", previousLimitBytes: null, newLimitBytes: "5000000000", planLimitBytes: null, changedByAdminEmail: "admin@example.test", changedAt: "2026-11-16T12:00:00.000Z" }]}
      />
    )
  );
  assert.match(t, /None \(plan applies\) → 5 GB/);
  assert.match(t, /admin@example.test · 16 Nov 2026/);
  assert.match(text(renderToStaticMarkup(<StorageHistoryList items={[]} />)), /No changes yet\./);
});

// ---- Loaders ------------------------------------------------------------------------------------------

test("loader: GET the teacher's storage, same-origin, no-store; API errors and network failures become messages", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const ok = await loadTeacherStorage(T1, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(200, { success: true, data: summary() });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, storageEndpoint(T1));
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.credentials, "same-origin");
  const denied = await loadTeacherStorage(T1, { fetchImpl: async () => json(403, { success: false, error: { message: "Admin privileges are required.", code: "FORBIDDEN" } }) });
  assert.deepEqual(denied, { ok: false, message: "Admin privileges are required." });
  const offline = await loadTeacherStorage(T1, {
    fetchImpl: async () => {
      throw new TypeError("network");
    },
  });
  assert.equal(offline.ok, false);
  const broken = await loadTeacherStorage(T1, { fetchImpl: async () => new Response("<html>", { status: 502 }) });
  assert.deepEqual(broken, { ok: false, message: "Unable to load storage usage." });
});

test("save: PUT {limitGB} or {removeOverride}; never a teacher id or admin in the body; errors surface", async () => {
  const sent: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    return json(200, { success: true, message: "The storage limit was saved.", data: { ...summary(), changed: true } });
  };
  const saved = await saveStorageLimit(T1, { limitGB: "12.5" }, { fetchImpl });
  assert.equal(saved.ok, true);
  await saveStorageLimit(T1, { removeOverride: true }, { fetchImpl });
  assert.equal(sent[0].url, storageLimitEndpoint(T1));
  assert.equal(sent[0].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(sent[0].init?.body)), { limitGB: "12.5" });
  assert.deepEqual(JSON.parse(String(sent[1].init?.body)), { removeOverride: true });
  const refused = await saveStorageLimit(T1, { limitGB: "-1" }, { fetchImpl: async () => json(400, { success: false, error: { message: "The limit cannot be negative.", code: "VALIDATION_ERROR" } }) });
  assert.deepEqual(refused, { ok: false, message: "The limit cannot be negative." });
  const history = await loadStorageHistory(T1, { fetchImpl: async () => json(200, { success: true, data: { items: [], pagination: {} } }) });
  assert.deepEqual(history, { ok: true, value: [] });
});

// ---- Shared parsing and formatting -------------------------------------------------------------------

test("GB parsing is exact decimal (BigInt, 9 decimals = 1 byte), 0 .. 1 PB; formatting is decimal and exact", () => {
  assert.deepEqual(parseStorageLimitGb("12.5"), { ok: true, bytes: BigInt(12_500_000_000) });
  assert.deepEqual(parseStorageLimitGb("0.000000001"), { ok: true, bytes: BigInt(1) });
  assert.deepEqual(parseStorageLimitGb(0), { ok: true, bytes: BigInt(0) });
  assert.deepEqual(parseStorageLimitGb("1000000"), { ok: true, bytes: BigInt("1000000000000000") });
  for (const bad of ["-1", "1.0000000001", "1000000.000000001", "1e3", " ", "abc", Infinity]) assert.equal(parseStorageLimitGb(bad).ok, false, String(bad));
  assert.equal(parseStorageLimitRequest({ limitGB: "1", teacherId: "x" }).ok, false);
  assert.equal(formatStorageBytes("1000000000000000"), "1 PB");
  assert.equal(formatStorageBytes("9007199254740993"), "9 PB");
  assert.equal(formatStorageBytes("999"), "999 bytes");
  assert.equal(formatStorageBytes("1"), "1 byte");
  assert.equal(bytesToGbInput("12500000000"), "12.5");
  assert.equal(bytesToGbInput("1"), "0.000000001");
});

test("the panel shows the Storage card for the selected teacher (keyed per teacher), next to the plan", () => {
  const panel = readFileSync(path.join(ROOT, "components", "admin-teacher-accounts-panel.tsx"), "utf8");
  assert.match(panel, /import \{ AdminTeacherStorageCard \} from "\.\/admin-teacher-storage-card";/);
  assert.match(panel, /\{selectedTeacher && <AdminTeacherStorageCard key=\{selectedTeacher\.id\} teacherId=\{selectedTeacher\.id\} \/>\}/);
  const card = readFileSync(path.join(ROOT, "components", "admin-teacher-storage-card.tsx"), "utf8");
  assert.doesNotMatch(card, /\btruncate\b|line-clamp|hidden sm:|hidden md:/, "no data hidden or truncated on small screens");
  assert.doesNotMatch(card, /Number\(\s*[a-z.]*Bytes/, "byte strings are never turned into Numbers");
});
