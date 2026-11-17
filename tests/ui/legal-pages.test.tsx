/**
 * Public legal pages (/terms, /privacy, /refund-policy), their footer links
 * and their metadata.
 *
 *   npm run test:ui
 *
 * Each page is rendered with react-dom/server (no DOM, no Next server): the
 * structure (title, sections, table of contents, contact, draft notice), the
 * absence of placeholders and invented commitments, and the shared footer and
 * navbar are checked from the markup. Anonymous access is covered by
 * tests/security/legal-pages-middleware.test.cjs; the rendered pages in a
 * browser are a manual check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import TermsPage, { metadata as termsMetadata } from "../../app/terms/page";
import PrivacyPage, { metadata as privacyMetadata } from "../../app/privacy/page";
import RefundPolicyPage, { metadata as refundMetadata } from "../../app/refund-policy/page";
import Footer from "../../components/Layout/footer";
import Navbar from "../../components/Layout/navbar";
import { termsSections } from "../../components/legal/terms-content";
import { privacySections } from "../../components/legal/privacy-content";
import { refundSections } from "../../components/legal/refund-content";
import type { LegalSection } from "../../components/legal/LegalPage";
import {
  LEGAL_BUSINESS_DETAILS,
  LEGAL_DOCUMENT_STATUS,
  LEGAL_OPEN_DECISIONS,
  LEGAL_PLATFORM,
  LEGAL_REFUND_RULES,
  formatLegalDate,
} from "../../lib/legal/config";

const ROOT = path.join(__dirname, "..", "..");

type PageCase = {
  path: "/terms" | "/privacy" | "/refund-policy";
  title: string;
  metaTitle: string;
  render: () => string;
  metadata: typeof termsMetadata;
  sections: LegalSection[];
  sectionCount: number;
};

const PAGES: PageCase[] = [
  {
    path: "/terms",
    title: "Terms &amp; Conditions",
    metaTitle: "SL Classroom Terms & Conditions",
    render: () => renderToStaticMarkup(<TermsPage />),
    metadata: termsMetadata,
    sections: termsSections,
    // 19 required sections + Governing Law and Jurisdiction + Teacher Subscriptions and Billing.
    sectionCount: 21,
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    metaTitle: "SL Classroom Privacy Policy",
    render: () => renderToStaticMarkup(<PrivacyPage />),
    metadata: privacyMetadata,
    sections: privacySections,
    sectionCount: 14,
  },
  {
    path: "/refund-policy",
    title: "Refund &amp; Cancellation Policy",
    metaTitle: "SL Classroom Refund & Cancellation Policy",
    render: () => renderToStaticMarkup(<RefundPolicyPage />),
    metadata: refundMetadata,
    sections: refundSections,
    // 15 required sections + Teacher Subscription Refunds.
    sectionCount: 16,
  },
];

/** Visible text only (tags removed), for wording checks. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

for (const page of PAGES) {
  test(`${page.path}: title, dates, draft notice and the full set of sections`, () => {
    const html = page.render();

    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, "exactly one h1");
    assert.match(html, new RegExp(`<h1[^>]*>${page.title}</h1>`));
    assert.match(html, new RegExp(`Last updated:.*${formatLegalDate(LEGAL_DOCUMENT_STATUS.lastUpdated)}`));
    if (LEGAL_DOCUMENT_STATUS.isDraft) {
      assert.match(html, /Draft under review\./);
      assert.match(html, /Not yet in effect/);
    }

    assert.equal(page.sections.length, page.sectionCount, "all required sections");
    const ids = page.sections.map((section) => section.id);
    assert.equal(new Set(ids).size, ids.length, "section ids are unique");
    for (const [index, section] of page.sections.entries()) {
      assert.ok(html.includes(`<section id="${section.id}"`), `section ${section.id} rendered`);
      assert.ok(html.includes(`id="${section.id}-heading"`), `section ${section.id} has an h2`);
      // Table of contents (mobile and desktop copies) links to every section.
      assert.equal(html.split(`href="#${section.id}"`).length - 1, 2, `toc links to ${section.id}`);
      assert.ok(html.includes(`${index + 1}.</span>${section.title.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}`));
    }
    assert.equal(page.sections.at(-1)?.id, "contact", "contact is the last section");
  });

  test(`${page.path}: contact email, related policies, shared navbar and footer`, () => {
    const html = page.render();

    assert.ok(html.includes(`href="mailto:${LEGAL_PLATFORM.contactEmail}"`));
    // The other two policies are linked from the page.
    for (const other of PAGES.filter((candidate) => candidate.path !== page.path)) {
      assert.ok(html.includes(`href="${other.path}"`), `links to ${other.path}`);
    }
    // Navbar section links lead back to the home page's sections.
    assert.ok(html.includes('href="/#platform"'));
    assert.ok(!html.includes('href="#platform"'));
    // The site footer, with its legal links.
    assert.ok(html.includes('aria-label="Legal"'));
  });

  test(`${page.path}: no placeholders, invented commitments or unconfirmed integrations`, () => {
    const text = textOf(page.render());

    for (const forbidden of [/TODO/i, /\bnull\b/, /\bundefined\b/, /\[object Object\]/, /PayHere/i, /lawyer[- ]approved/i, /\bcertified\b/i, /\bwe (will )?guarantee\b/i, /\bguaranteed\b/i]) {
      assert.doesNotMatch(text, forbidden);
    }
    // No refund percentages, fixed processing periods or invented deadlines.
    assert.doesNotMatch(text, /\d+\s?%/);
    assert.doesNotMatch(text, /\b\d+\s*(working |business )?(days?|hours?|weeks?)\b/i);
    // Unconfirmed business details stay off the page.
    if (!LEGAL_BUSINESS_DETAILS.operatorName) assert.doesNotMatch(text, /Operated by:/);
    if (!LEGAL_BUSINESS_DETAILS.businessAddress) assert.doesNotMatch(text, /Address:/);
  });

  test(`${page.path}: metadata (absolute title, description, canonical, robots)`, () => {
    const meta = page.metadata;
    assert.deepEqual(meta.title, { absolute: page.metaTitle });
    assert.ok(typeof meta.description === "string" && meta.description.length >= 70);
    assert.deepEqual(meta.alternates, { canonical: page.path });
    assert.deepEqual(meta.robots, { index: !LEGAL_DOCUMENT_STATUS.isDraft, follow: true });
    assert.equal(meta.openGraph?.url, page.path);
  });

  test(`${page.path}: static route folder exists (takes precedence over the teacher [slug] route)`, () => {
    assert.ok(existsSync(path.join(ROOT, "app", page.path.slice(1), "page.tsx")));
  });
}

test("drafts are noindex and show 'Not yet in effect' (guard against publishing an unreviewed draft)", () => {
  assert.equal(LEGAL_DOCUMENT_STATUS.isDraft, true);
  assert.equal(LEGAL_DOCUMENT_STATUS.effectiveDate, null);
});

test("payment wording: no online processing, tuition goes to teachers, platform cannot refund it", () => {
  const terms = textOf(renderToStaticMarkup(<TermsPage />));
  const privacy = textOf(renderToStaticMarkup(<PrivacyPage />));
  const refund = textOf(renderToStaticMarkup(<RefundPolicyPage />));

  assert.match(terms, /does not currently offer online payment processing/);
  assert.match(terms, /Tuition fees are separate from any charges for using SL Classroom/);
  assert.match(privacy, /does not collect payment card numbers/);
  assert.match(refund, /does not process online payments and does not receive or hold tuition fees/);
  assert.match(refund, /cannot itself refund, reverse or withhold a payment made to a teacher/);
  assert.match(refund, /Nothing in this policy creates an automatic right to a refund/);
});

test("refund policy: undecided notice periods fall back to the teacher's own terms", () => {
  const refund = textOf(renderToStaticMarkup(<RefundPolicyPage />));
  if (LEGAL_REFUND_RULES.studentCancellationNotice === null) {
    assert.match(refund, /within any notice period the teacher has set/);
  }
});

test("open decisions: one checklist, unique ids, valid pages", () => {
  const ids = LEGAL_OPEN_DECISIONS.map((decision) => decision.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const decision of LEGAL_OPEN_DECISIONS) {
    assert.ok(decision.question.length > 20, decision.id);
    assert.ok(decision.pages.length > 0, decision.id);
    for (const key of decision.pages) assert.ok(["terms", "privacy", "refund-policy"].includes(key), decision.id);
  }
  for (const required of ["operator-identity", "governing-law", "legal-review", "payment-architecture", "cancellation-notice", "refund-window", "minimum-age", "retention-periods"]) {
    assert.ok(ids.includes(required), required);
  }
});

test("formatLegalDate", () => {
  assert.equal(formatLegalDate("2026-11-17"), "17 November 2026");
  assert.equal(formatLegalDate("2026-01-05"), "5 January 2026");
  assert.equal(formatLegalDate("soon"), "soon");
  assert.equal(formatLegalDate("2026-13-01"), "2026-13-01");
});

test("footer: existing links kept, the three legal links added", () => {
  const html = renderToStaticMarkup(<Footer />);
  for (const [href, label] of [
    ["/login", "Login"],
    ["/register", "Register"],
    ["/guardian/login", "Guardian Login"],
    ["/terms", "Terms &amp; Conditions"],
    ["/privacy", "Privacy Policy"],
    ["/refund-policy", "Refund &amp; Cancellation Policy"],
  ]) {
    assert.match(html, new RegExp(`href="${href}"[^>]*>${label}</a>`), href);
  }
  assert.equal((html.match(/<footer/g) ?? []).length, 1, "one footer");
});

test("navbar on the home page is unchanged (section links stay in-page anchors)", () => {
  const html = renderToStaticMarkup(<Navbar />);
  for (const anchor of ["#platform", "#dashboard", "#live", "#after-class", "#students", "#security"]) {
    assert.ok(html.includes(`href="${anchor}"`), anchor);
  }
  assert.ok(html.includes('href="/login"'));
  assert.ok(html.includes('href="/register"'));
});
