/**
 * Admin teacher detail: the Subscription card
 * (components/admin-teacher-subscription-card.tsx) that replaced the
 * read-only plan box in components/admin-teacher-accounts-panel.tsx. Views
 * render with react-dom/server; loaders run over a fake fetch with real
 * Response objects. No browser, no server.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PlanEditor,
  SubscriptionErrorView,
  SubscriptionLoadingView,
  SubscriptionOverview,
  formatPlanPrice,
  isCurrentAssignment,
  loadTeacherSubscription,
  planOptionLabel,
  saveTeacherSubscriptionPlan,
  subscriptionEndpoint,
  type AdminPlanOption,
  type AdminSubscriptionSummary,
} from "../../components/admin-teacher-subscription-card";

const ROOT = path.join(__dirname, "..", "..");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const T1 = "11111111-1111-4111-8111-111111111111";

const plan = (id: string, name: string, price: number, status = "ACTIVE", storageGB: number | null = null): AdminPlanOption => ({
  id,
  name,
  description: null,
  price,
  currency: "LKR",
  interval: "MONTHLY",
  maxLiveParticipants: 150,
  storageGB,
  status,
});

const STARTER = plan("p-starter", "Starter", 5500);
const GROWTH = plan("p-growth", "Growth", 8500, "ACTIVE", 50);
const CUSTOM = plan("p-custom", "Institution", 40000, "INACTIVE");

const withSubscription: AdminSubscriptionSummary = {
  teacher: { id: T1, name: "T", email: "t@example.test" },
  subscription: {
    id: "s1",
    planId: STARTER.id,
    planName: "Starter",
    planStatus: "ACTIVE",
    interval: "MONTHLY",
    status: "ACTIVE",
    price: 5500,
    currency: "LKR",
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: null,
    autoRenew: true,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  plans: [STARTER, GROWTH, CUSTOM],
};
const noSubscription: AdminSubscriptionSummary = { ...withSubscription, subscription: null };

const editor = (summary: AdminSubscriptionSummary, selectedPlanId: string, extra: Partial<{ saving: boolean; error: string | null }> = {}) =>
  renderToStaticMarkup(
    <PlanEditor summary={summary} selectedPlanId={selectedPlanId} saving={extra.saving ?? false} error={extra.error ?? null} onChange={() => {}} onSave={() => {}} />
  );

test("formatting: price with currency and interval; inactive plans are labelled", () => {
  assert.equal(formatPlanPrice(5500, "LKR", "MONTHLY"), "LKR 5,500 per month");
  assert.equal(formatPlanPrice(12500.5, "LKR", "YEARLY"), "LKR 12,500.5 per year");
  assert.equal(planOptionLabel(STARTER), "Starter (LKR 5,500 per month)");
  assert.equal(planOptionLabel(CUSTOM), "Institution (LKR 40,000 per month) (inactive)");
});

test("overview: current plan, price, interval, status, dates and auto-renew", () => {
  const out = text(renderToStaticMarkup(<SubscriptionOverview summary={withSubscription} />));
  assert.match(out, /Current plan Starter/);
  assert.match(out, /Price LKR 5,500 per month/);
  assert.match(out, /Status ACTIVE/);
  assert.match(out, /Start date 1 Sept? 2026/);
  assert.match(out, /End date No end date/);
  assert.match(out, /Auto-renew On/);
});

test("overview: a teacher without a subscription is told so", () => {
  const out = text(renderToStaticMarkup(<SubscriptionOverview summary={noSubscription} />));
  assert.match(out, /no subscription yet/);
});

test("editor: every plan is offered (inactive ones too); the selected plan's price and interval show before saving", () => {
  const html = editor(withSubscription, GROWTH.id);
  const out = text(html);
  for (const p of [STARTER, GROWTH, CUSTOM]) assert.ok(html.includes(`value="${p.id}"`), p.name);
  assert.match(out, /Growth: LKR 8,500 per month/);
  assert.match(out, /Up to 150 live participants · Storage: 50 GB/);
  assert.match(out, /Save plan/);
  assert.match(out, /does not record a payment/);
  assert.doesNotMatch(html, /<button type="submit" disabled=""/, "a different plan can be saved");
});

test("editor: inactive plan warning; 'Assign plan' when there is no subscription", () => {
  const out = text(editor(noSubscription, CUSTOM.id));
  assert.match(out, /Assign a plan/);
  assert.match(out, /Assign plan/);
  assert.match(out, /This plan is inactive/);
});

test("editor: Save is disabled with no selection, while saving, and for the current assignment", () => {
  assert.match(editor(withSubscription, ""), /<button type="submit" disabled=""/);
  assert.match(editor(withSubscription, GROWTH.id, { saving: true }), /<button type="submit" disabled=""/);
  const current = editor(withSubscription, STARTER.id);
  assert.match(current, /<button type="submit" disabled=""/);
  assert.match(text(current), /already on this plan/);
  assert.equal(isCurrentAssignment(withSubscription, STARTER.id), true);
  assert.equal(isCurrentAssignment(withSubscription, GROWTH.id), false);
  assert.equal(isCurrentAssignment(noSubscription, STARTER.id), false);
});

test("editor: a save error is shown as an alert", () => {
  const html = editor(withSubscription, GROWTH.id, { error: "Subscription plan not found." });
  assert.match(html, /role="alert"[^>]*>Subscription plan not found\.</);
});

test("loading and error views", () => {
  assert.match(text(renderToStaticMarkup(<SubscriptionLoadingView />)), /Loading subscription/);
  assert.match(renderToStaticMarkup(<SubscriptionErrorView message="Teacher not found." onRetry={() => {}} />), /role="alert"[^>]*>Teacher not found\./);
});

test("loaders: GET the endpoint; PUT sends ONLY the plan id; server errors surface their message", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PUT") return json(200, { success: true, data: { changed: true, ...withSubscription }, message: "The subscription plan was updated." });
    return json(200, { success: true, data: withSubscription });
  };

  const loaded = await loadTeacherSubscription(T1, { fetchImpl });
  assert.ok(loaded.ok && loaded.value.subscription?.planName === "Starter");
  assert.equal(calls[0].url, subscriptionEndpoint(T1));
  assert.equal(subscriptionEndpoint(T1), `/api/admin/teachers/${T1}/subscription`);

  const saved = await saveTeacherSubscriptionPlan(T1, GROWTH.id, { fetchImpl });
  assert.ok(saved.ok && saved.value.message === "The subscription plan was updated.");
  assert.equal(calls[1].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { planId: GROWTH.id }, "no price or currency is sent");

  const failing = async () => json(404, { success: false, error: { message: "Subscription plan not found.", code: "PLAN_NOT_FOUND" } });
  const failed = await saveTeacherSubscriptionPlan(T1, "x", { fetchImpl: failing });
  assert.deepEqual(failed, { ok: false, message: "Subscription plan not found." });

  const offline = async () => {
    throw new TypeError("network");
  };
  const down = await loadTeacherSubscription(T1, { fetchImpl: offline });
  assert.equal(down.ok, false);
});

test("the panel renders the Subscription card (keyed per teacher) instead of the old read-only plan box", () => {
  const panel = readFileSync(path.join(ROOT, "components", "admin-teacher-accounts-panel.tsx"), "utf8");
  assert.match(panel, /import \{ AdminTeacherSubscriptionCard \} from "\.\/admin-teacher-subscription-card";/);
  assert.match(panel, /\{selectedTeacher && <AdminTeacherSubscriptionCard key=\{selectedTeacher\.id\} teacherId=\{selectedTeacher\.id\} \/>\}/);
  assert.doesNotMatch(panel, /teacherSubscription|border-violet-200 bg-violet-50/, "the old box and its state are gone");
  const card = readFileSync(path.join(ROOT, "components", "admin-teacher-subscription-card.tsx"), "utf8");
  assert.doesNotMatch(card, /\btruncate\b|line-clamp|hidden sm:|hidden md:/, "no data hidden or truncated on small screens");
});
