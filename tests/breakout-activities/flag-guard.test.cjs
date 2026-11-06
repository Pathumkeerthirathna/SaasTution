/*
 * Guard: the Breakout Activities feature flag gates the breakout APIs only.
 * It must never bypass the session end / replacement safety checks
 * (export confirmation, detection and cleanup of existing breakout data),
 * because data created while the flag was on must still be handled after it
 * is turned off.
 *
 * Static check: only breakout API routes (app/api/sessions/[id]/breakout-activities/**)
 * and instrumentation.ts may import lib/breakout-activities/flag. The session
 * service, the session end / start / restart routes and every other module
 * must not.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

const SCANNED_DIRS = ["app", "lib", "services", "components"];
const SCANNED_FILES = ["instrumentation.ts", "middleware.ts"];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// import ... from "...breakout-activities/flag" (with or without extension),
// require("..."), import("..."), or a relative "./flag" inside the folder.
const FLAG_IMPORT = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["'](?:[^"']*breakout-activities\/flag|\.\/flag)(?:\.ts)?["']/;

const ALLOWED = [
  /^app\/api\/sessions\/\[id\]\/breakout-activities\//,
  /^instrumentation\.ts$/,
  /^lib\/breakout-activities\/flag\.ts$/,
];

// Must never import the flag, whatever ALLOWED says.
const SAFETY_CRITICAL = [
  "services/session-service.ts",
  "services/breakout-session-data.ts",
  "services/breakout-group-session-end.ts",
  "app/api/sessions/[id]/end/route.ts",
  "app/api/sessions/[id]/restart/route.ts",
  "app/api/classes/[id]/sessions/start/route.ts",
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

function importers() {
  const files = [];
  for (const d of SCANNED_DIRS) walk(path.join(root, d), files);
  for (const f of SCANNED_FILES) if (fs.existsSync(path.join(root, f))) files.push(path.join(root, f));
  return files.filter((file) => FLAG_IMPORT.test(fs.readFileSync(file, "utf8"))).map(rel);
}

test("the import pattern recognizes every import form", () => {
  for (const line of [
    'import { isBreakoutActivitiesEnabled } from "@/lib/breakout-activities/flag";',
    "import { x } from '../../lib/breakout-activities/flag.ts';",
    'const f = require("@/lib/breakout-activities/flag");',
    'const f = await import("@/lib/breakout-activities/flag");',
    'import { x } from "./flag";',
  ]) {
    assert.match(line, FLAG_IMPORT, line);
  }
  assert.doesNotMatch('import { x } from "@/lib/breakout-activities/flags-other";', FLAG_IMPORT);
});

test("the allowed route prefix is the approved base path only", () => {
  assert.equal(ALLOWED[0].test("app/api/sessions/[id]/breakout-activities/assignments/route.ts"), true);
  assert.equal(ALLOWED[0].test("app/api/sessions/[id]/breakout/route.ts"), false);
  assert.equal(ALLOWED[0].test("app/api/sessions/[id]/breakout-activitiesX/route.ts"), false);
  assert.equal(ALLOWED[0].test("app/api/sessions/[id]/end/route.ts"), false);
});

test("only breakout API routes and instrumentation.ts import the flag", () => {
  const offending = importers().filter((file) => !ALLOWED.some((re) => re.test(file)));
  assert.deepEqual(offending, [], `the flag must not be imported by: ${offending.join(", ")}`);
});

test("session end / replacement code never imports the flag", () => {
  for (const file of SAFETY_CRITICAL) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue; // services/breakout-session-data.ts arrives in Step 5
    assert.doesNotMatch(fs.readFileSync(full, "utf8"), FLAG_IMPORT, `${file} must not import the feature flag`);
  }
});
