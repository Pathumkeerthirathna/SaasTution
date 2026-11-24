/**
 * Server / client module boundary: a server file (no "use client") must not
 * import VALUES other than components from a "use client" module. On the
 * server such an export is a client reference, not the value, so reading it
 * fails at runtime ("Cannot access X.title on the server. You cannot dot into
 * a client module from a server component"), which unit tests that import the
 * module directly under Node never see. Components (PascalCase) and type
 * imports are fine; anything else (constants, helpers) belongs in a plain
 * module both sides import (e.g. components/student-portal/recordings/student-youtube-text.ts).
 * Static analysis of app/ and components/.
 *
 *   npm run test:ui
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** "use client" as the first statement (comments before it allowed). */
const isClientModule = (src: string) => /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src);

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.join(ROOT, path.dirname(fromFile), spec);
  else return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext)) return base + ext;
  return null;
}

/** A component name (PascalCase, not an ALL_CAPS constant). */
const isComponentName = (name: string) => /^[A-Z][a-z]/.test(name) && !/^[A-Z0-9_]+$/.test(name);

/** The non-component values a server file imports from client modules. */
export function serverReadsOfClientValues(files: string[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    if (isClientModule(src)) continue;
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
      if (m[1]) continue; // import type { ... }
      const target = resolveImport(file, m[3]);
      if (!target || !isClientModule(readFileSync(target, "utf8"))) continue;
      const values = m[2]
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith("type "))
        .map((n) => n.split(/\s+as\s+/)[0])
        .filter((n) => !isComponentName(n));
      if (values.length) findings.push(`${file}: ${values.join(", ")} from ${m[3]}`);
    }
  }
  return findings;
}

test("no server file reads a non-component value from a \"use client\" module", () => {
  assert.deepEqual(serverReadsOfClientValues([...walk("app"), ...walk("components")]), []);
});

test("the student YouTube pages: the server page reads its titles from the plain module, only the component from the client module", () => {
  const page = readFileSync(path.join(ROOT, "components", "student-portal", "recordings", "student-youtube-page.tsx"), "utf8");
  assert.match(page, /import \{ StudentYouTubeClient \} from "@\/components\/student-portal\/recordings\/student-youtube-client";/);
  assert.match(page, /import \{ STUDENT_YOUTUBE_TEXT, type StudentYouTubeKind \} from "@\/components\/student-portal\/recordings\/student-youtube-text";/);
  const text = readFileSync(path.join(ROOT, "components", "student-portal", "recordings", "student-youtube-text.ts"), "utf8");
  assert.equal(isClientModule(text), false, "a plain module");
  assert.match(text, /title: "Live Recordings"/);
  assert.match(text, /title: "YouTube Live Sessions"/);
});
