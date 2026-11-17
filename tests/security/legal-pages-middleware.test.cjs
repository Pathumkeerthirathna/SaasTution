/*
 * The public legal pages (/terms, /privacy, /refund-policy) are reachable
 * without signing in, and adding them changed nothing in route protection:
 * they are outside every protected prefix and the middleware matcher, and
 * the protected areas still require a session.
 *
 *   npm run test:security
 *
 * The real middleware, in-process (throwaway JWT_SECRET). No server, no database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.JWT_SECRET = "legal-pages-middleware-test-secret-0123456789";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { NextRequest } = require("next/server");
const { middleware, config } = require(path.join(root, "middleware.ts"));

const APP_ORIGIN = "https://app.example.test";
const LEGAL_PAGES = ["/terms", "/privacy", "/refund-policy"];

const request = (url) => new NextRequest(`${APP_ORIGIN}${url}`);
const passesThrough = (response) => response.headers.get("x-middleware-next") === "1";

/** The static part of a matcher entry ("/dashboard/:path*" -> "/dashboard"). */
const matcherPrefix = (entry) => entry.split("/:")[0];

test("no middleware matcher entry covers the legal pages", () => {
  for (const page of LEGAL_PAGES) {
    for (const entry of config.matcher) {
      const prefix = matcherPrefix(entry);
      assert.ok(!(page === prefix || page.startsWith(`${prefix}/`)), `${entry} must not match ${page}`);
    }
  }
});

test("anonymous visitors reach the legal pages (no redirect to login)", async () => {
  for (const page of LEGAL_PAGES) {
    for (const url of [page, `${page}#contact`, `${page}?ref=footer`]) {
      const response = await middleware(request(url));
      assert.ok(passesThrough(response), url);
      assert.equal(response.headers.get("location"), null, url);
    }
  }
});

test("protected areas still require a session", async () => {
  for (const url of ["/dashboard", "/student/dashboard", "/account"]) {
    const response = await middleware(request(url));
    assert.equal(response.status, 307, url);
    assert.equal(new URL(response.headers.get("location")).pathname, "/login", url);
  }
  for (const url of ["/api/students", "/api/classes", "/api/admin/teachers"]) {
    const response = await middleware(request(url));
    assert.equal(response.status, 401, url);
  }
});
