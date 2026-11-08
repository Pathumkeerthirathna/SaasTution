/*
 * Static guards for the secret-rotation tool (no database needed).
 *
 *   npm run test:student-qr
 *
 * The reissue service may only be reached from the operator CLI: never from
 * an API route, page, component, middleware or instrumentation, so it can
 * never run at application startup or during QR rendering.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function sourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  return out;
}

test("the reissue service is imported only by the operator CLI", () => {
  const importers = [];
  for (const dir of ["app", "components", "lib", "services", "hooks", "scripts"]) {
    for (const file of sourceFiles(dir)) {
      if (/student-qr-reissue/.test(code(fs.readFileSync(file, "utf8")))) importers.push(path.relative(root, file).replace(/\\/g, "/"));
    }
  }
  for (const file of ["middleware.ts", "instrumentation.ts"]) {
    if (fs.existsSync(path.join(root, file))) assert.doesNotMatch(code(read(file)), /student-qr-reissue/, file);
  }
  assert.deepEqual(importers, ["scripts/student-qr-reissue.ts"]);
});

test("the CLI reads secrets only from the environment and needs explicit confirmation", () => {
  const cli = code(read("scripts/student-qr-reissue.ts"));
  assert.match(cli, /process\.env\[STUDENT_QR_REISSUE_OLD_SECRET_ENV\]/);
  assert.match(cli, /process\.env\[STUDENT_QR_REISSUE_NEW_SECRET_ENV\]/);
  assert.doesNotMatch(cli, /process\.env\.STUDENT_QR_SECRET\b/, "never the application's own variable");
  assert.match(cli, /--confirm-reissue-all-student-qr/);
  assert.match(cli, /--confirm-database=/);
  assert.match(cli, /Unknown argument \(value not shown\)/);
  assert.doesNotMatch(cli, /writeFile|appendFile|\.env["'`]/, "never writes files");

  const service = code(read("services/student-qr-reissue-service.ts"));
  assert.doesNotMatch(service, /console\.|writeFile|process\.env/, "the service neither logs nor reads the environment");
  assert.match(service, /SET TRANSACTION READ ONLY/);
  assert.match(service, /FOR NO KEY UPDATE/);
  assert.match(service, /revokedByRole: "SYSTEM", revokedById: null, revokedReason: "SYSTEM_REISSUE"/);
  assert.match(service, /reason: "SYSTEM_REISSUE" as const,[\s\S]*createdByRole: "SYSTEM",\s*createdById: null/);
});

test("the npm script runs the CLI with the server condition (server-only modules)", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["qr:reissue"], "tsx --conditions=react-server scripts/student-qr-reissue.ts");
  for (const name of ["dev", "build", "start", "postinstall", "prestart", "predev"]) {
    assert.doesNotMatch(pkg.scripts[name] ?? "", /qr:reissue|student-qr-reissue/, `${name} never runs the reissue`);
  }
});
