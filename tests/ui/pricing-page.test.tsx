/**
 * The public pricing page (/pricing): app/pricing/page.tsx,
 * components/pricing/PricingPage.tsx and services/public-pricing-service.ts.
 *
 *   npm run test:ui
 *
 * Views render with react-dom/server. The service and the page module run
 * against a fake lib/prisma (installed in require.cache before they are
 * loaded), so no database is touched. The middleware check runs the real
 * middleware in-process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import Footer from "../../components/Layout/footer";
import {
  BillingInfo,
  PlanCard,
  PricingContent,
  PricingLoadingView,
  billingIntervalsText,
  formatPlanAmount,
  institutionMailto,
  isInstitutionPlan,
  planFeatures,
} from "../../components/pricing/PricingPage";
import { LEGAL_BUSINESS_DETAILS, LEGAL_PLATFORM } from "../../lib/legal/config";
import type { PublicPlan } from "../../services/public-pricing-service";

const ROOT = path.join(__dirname, "..", "..");
// Loads modules through the shared module cache (where the faked lib/prisma is installed).
const load = createRequire(__filename);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const plan = (overrides: Partial<PublicPlan> & Pick<PublicPlan, "id" | "name" | "price">): PublicPlan => ({
  description: null,
  currency: "LKR",
  interval: "MONTHLY",
  maxLiveParticipants: 100,
  unlimitedLiveSessions: true,
  unlimitedRecording: true,
  unlimitedStudents: true,
  storageGB: null,
  ...overrides,
});

// Deliberately unusual values, so a match proves they come from the data.
const ALPHA = plan({ id: "p1", name: "Alpha", price: 1234, maxLiveParticipants: 37, description: "For small groups." });
const BETA = plan({ id: "p2", name: "Beta", price: 98765.5, interval: "YEARLY", maxLiveParticipants: 1234, storageGB: 75, unlimitedRecording: false, unlimitedLiveSessions: false, unlimitedStudents: false });
const INSTITUTION = plan({ id: "p3", name: "Institution Plus", price: 50000, maxLiveParticipants: 400 });

const render = (plans: PublicPlan[]) => renderToStaticMarkup(<PricingContent state={{ kind: "ready", plans }} />);

/* ---------- Views ---------- */

test("plan cards show name, description, price with its interval, billing basis and the plan's own features", () => {
  const out = text(render([ALPHA, BETA]));
  assert.match(out, /Alpha For small groups\. LKR 1,234 per month Billed monthly/);
  assert.match(out, /Up to 37 live classroom participants/);
  assert.match(out, /Unlimited LMS student registrations/);
  assert.match(out, /Beta LKR 98,765\.5 per year Billed yearly/);
  assert.match(out, /Up to 1,234 live classroom participants/);
  assert.match(out, /75 GB file storage/);
});

test("features come only from the plan's fields (no claim when a flag is off)", () => {
  assert.deepEqual(planFeatures(ALPHA), [
    "Up to 37 live classroom participants",
    "Unlimited LMS student registrations",
    "Unlimited live classes",
    "Unlimited recording sessions",
    "Unlimited file storage",
  ]);
  assert.deepEqual(planFeatures(BETA), ["Up to 1,234 live classroom participants", "75 GB file storage"]);
});

test("plans render in the order given (the service's sortOrder)", () => {
  const out = text(render([BETA, ALPHA]));
  assert.ok(out.indexOf("Beta") < out.indexOf("Alpha"));
});

test("standard plans: an accessible 'Get started' link to the existing /register route", () => {
  const html = renderToStaticMarkup(<PlanCard plan={ALPHA} />);
  const link = html.match(/<a [^>]*aria-label="Get started with the Alpha plan"[^>]*>/)?.[0] ?? "";
  assert.match(link, /href="\/register"/);
  assert.doesNotMatch(html, /mailto:/);
});

test("no active Institution plan: a separate custom-pricing contact card using the configured contact details", () => {
  const html = render([ALPHA, BETA]);
  const out = text(html);
  assert.match(out, /Institution Custom pricing/);
  assert.ok(html.includes(`href="${institutionMailto().replace(/&/g, "&amp;")}"`));
  assert.ok(institutionMailto().startsWith(`mailto:${LEGAL_PLATFORM.contactEmail}?subject=`));
  if (LEGAL_BUSINESS_DETAILS.telephone) assert.ok(out.includes(LEGAL_BUSINESS_DETAILS.telephone));
  assert.doesNotMatch(out, /Institution[^.]*LKR/, "no invented institution price");
});

test("an active Institution plan is shown with its database price and a contact action (no extra card)", () => {
  assert.equal(isInstitutionPlan(INSTITUTION), true);
  assert.equal(isInstitutionPlan(ALPHA), false);
  const html = render([ALPHA, INSTITUTION]);
  const out = text(html);
  assert.match(out, /Institution Plus LKR 50,000 per month/);
  assert.doesNotMatch(out, /Custom pricing/);
  assert.match(html, /aria-label="Contact us about the Institution Plus plan"/);
  assert.doesNotMatch(html, /aria-label="Get started with the Institution Plus plan"/);
});

test("billing: intervals from the plans; current vs not-yet-available payment clearly separated; no gateway claims", () => {
  assert.equal(billingIntervalsText([ALPHA]), "monthly");
  assert.equal(billingIntervalsText([BETA]), "yearly");
  assert.equal(billingIntervalsText([ALPHA, BETA]), "monthly or yearly");
  const out = text(renderToStaticMarkup(<BillingInfo plans={[ALPHA, BETA]} />));
  assert.match(out, /Plans are billed monthly or yearly/);
  assert.match(out, /Available now .*our team will contact you to confirm your subscription and arrange payment/);
  assert.match(out, /Not available yet Online card payment/);
  assert.match(out, /separate from the tuition fees/);
  assert.doesNotMatch(out, /PayHere|recurring|automatic(ally)? renew/i);
});

test("empty catalogue: a status message and the institution contact card, no plan cards", () => {
  const html = render([]);
  const out = text(html);
  assert.match(html, /role="status"[^>]*>.*Our plans are being updated/);
  assert.match(out, /Institution Custom pricing/);
  assert.doesNotMatch(html, /Get started with the/);
});

test("error and loading states", () => {
  const error = renderToStaticMarkup(<PricingContent state={{ kind: "error" }} />);
  assert.match(error, /role="alert"/);
  assert.match(text(error), /couldn.t load our plans/);
  assert.match(error, /href="\/pricing"/);
  assert.match(renderToStaticMarkup(<PricingLoadingView />), /role="status"[^>]*>Loading plans/);
});

test("formatting: zero price reads Free", () => {
  assert.equal(formatPlanAmount({ price: 0, currency: "LKR" }), "Free");
  assert.equal(formatPlanAmount({ price: 5500, currency: "LKR" }), "LKR 5,500");
});

test("the view hard-codes no prices, capacities or payment gateway", () => {
  const source = readFileSync(path.join(ROOT, "components", "pricing", "PricingPage.tsx"), "utf8");
  assert.doesNotMatch(source, /\b(5,?500|8,?500|12,?500)\b|\b(100|150|250|300|500)\s*(live|participants)/);
  assert.doesNotMatch(source, /PayHere/i);
  assert.doesNotMatch(source, /\btruncate\b|line-clamp|hidden sm:|hidden md:/, "no data hidden on small screens");
});

test("footer links to /pricing and keeps its existing links", () => {
  const html = renderToStaticMarkup(<Footer />);
  for (const href of ["/pricing", "/login", "/register", "/guardian/login", "/terms", "/privacy", "/refund-policy"]) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
});

/* ---------- Service and page module (fake database) ---------- */

type FindManyArgs = { where: unknown; orderBy: unknown; select: Record<string, boolean> };
const prismaCalls: FindManyArgs[] = [];
let prismaResult: () => Promise<unknown[]> = async () => [];
const errorLog: unknown[] = [];

function fake(filename: string, exports: unknown) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

function loadServerModules() {
  fake(path.join(ROOT, "lib", "prisma.ts"), {
    prisma: {
      subscriptionPlan: {
        findMany: async (args: FindManyArgs) => {
          prismaCalls.push(args);
          return prismaResult();
        },
      },
    },
  });
  const logger = load(path.join(ROOT, "lib", "error-logging", "server-logger.ts"));
  logger.setErrorLogSinkForTests({
    write: async (_channel: string, entry: unknown) => {
      errorLog.push(entry);
    },
    writeSync: (_channel: string, entry: unknown) => {
      errorLog.push(entry);
    },
    flush: async () => {},
  });
  return {
    service: load(path.join(ROOT, "services", "public-pricing-service.ts")),
    page: load(path.join(ROOT, "app", "pricing", "page.tsx")),
  };
}

test("service: ACTIVE plans only, by sortOrder then creation, public fields only, prices as numbers", async () => {
  const { service } = loadServerModules();
  const { Prisma } = load("@prisma/client");
  prismaCalls.length = 0;
  prismaResult = async () => [{ ...ALPHA, price: new Prisma.Decimal("1234.00") }];

  const plans = await service.getPublicSubscriptionPlans();

  assert.equal(prismaCalls.length, 1);
  assert.deepEqual(prismaCalls[0].where, { status: "ACTIVE" });
  assert.deepEqual(prismaCalls[0].orderBy, [{ sortOrder: "asc" }, { createdAt: "asc" }]);
  assert.deepEqual(Object.keys(prismaCalls[0].select).sort(), [
    "currency",
    "description",
    "id",
    "interval",
    "maxLiveParticipants",
    "name",
    "price",
    "storageGB",
    "unlimitedLiveSessions",
    "unlimitedRecording",
    "unlimitedStudents",
  ]);
  assert.equal(plans[0].price, 1234);
  assert.equal(typeof plans[0].price, "number");
});

test("service: a database failure becomes the error state and is logged", async () => {
  const { service } = loadServerModules();
  errorLog.length = 0;
  const state = await service.loadPricingState(async () => {
    throw new Error("database unavailable");
  });
  assert.deepEqual(state, { kind: "error" });
  assert.equal(errorLog.length, 1);

  const ready = await service.loadPricingState(async () => [ALPHA]);
  assert.deepEqual(ready, { kind: "ready", plans: [ALPHA] });
});

test("page: SEO metadata (title, description, canonical, Open Graph) and per-request rendering", () => {
  const { page } = loadServerModules();
  assert.equal(page.dynamic, "force-dynamic");
  assert.equal(page.metadata.title, "Pricing");
  assert.ok(page.metadata.description.length >= 70);
  assert.deepEqual(page.metadata.alternates, { canonical: "/pricing" });
  assert.equal(page.metadata.openGraph.url, "/pricing");
  assert.equal(page.metadata.openGraph.title, "SL Classroom Pricing");
});

test("page: renders the plans from the database inside the site navbar and footer", async () => {
  const { page } = loadServerModules();
  const { Prisma } = load("@prisma/client");
  prismaResult = async () => [{ ...ALPHA, price: new Prisma.Decimal(1234) }];
  const html = renderToStaticMarkup(await page.default());
  const out = text(html);
  assert.match(out, /Plans for teaching online/);
  assert.match(out, /Alpha .*LKR 1,234 per month/);
  assert.ok(html.includes('href="/#platform"'), "navbar links back to the home page sections");
  assert.ok(html.includes('aria-label="Legal"'), "site footer");
});

test("middleware: /pricing is public (outside every protected prefix)", async () => {
  process.env.JWT_SECRET ??= "pricing-page-test-secret-0123456789abcdef";
  const { middleware, config } = load(path.join(ROOT, "middleware.ts"));
  const { NextRequest } = load("next/server");
  for (const entry of config.matcher as string[]) {
    const prefix = entry.split("/:")[0];
    assert.ok(!("/pricing" === prefix || "/pricing".startsWith(`${prefix}/`)), entry);
  }
  const response = await middleware(new NextRequest("https://app.example.test/pricing"));
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
