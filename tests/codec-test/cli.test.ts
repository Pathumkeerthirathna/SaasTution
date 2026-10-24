/*
 * Codec test command-line scripts: argument parsing, and both scripts run as
 * child processes.
 *
 *   npm run test:codec
 *
 * The link generator runs against a fake domain (meet.example.test) with a
 * random throwaway signing secret and a private temp folder: the real .env
 * is never loaded (no --env-file), every inherited JITSI_* variable is
 * removed, and no production token can be created. The tokens it writes are
 * checked against the throwaway secret, never printed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { parseArgs, UsageError } from "../../scripts/codec-test/cli";
import { verifyTestToken } from "../../scripts/codec-test/token";

const ROOT = path.resolve(__dirname, "..", "..");
const LINKS = path.join(ROOT, "scripts", "codec-test-links.ts");
const STATS = path.join(ROOT, "scripts", "codec-test-stats.ts");
const work = mkdtempSync(path.join(tmpdir(), "sl-codec-cli-test-"));

after(() => rmSync(work, { recursive: true, force: true }));

function run(script: string, args: string[], env: Record<string, string> = {}, tempDir = work) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  Object.keys(childEnv).filter((key) => key.startsWith("JITSI_")).forEach((key) => delete childEnv[key]);
  Object.assign(childEnv, { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir }, env);

  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---- parseArgs --------------------------------------------------------------------

const SPEC = { "--arm": "value", "--teacher": "value", "--json": "flag" } as const;

test("parseArgs: '--name value', '--name=value' and flags", () => {
  assert.deepEqual(parseArgs(["--arm", "B", "--teacher=t.txt", "--json"], SPEC), { "--arm": "B", "--teacher": "t.txt", "--json": true });
  assert.deepEqual(parseArgs([], SPEC), {});
});

test("parseArgs: malformed command lines are refused", () => {
  const cases: Array<[string[], RegExp]> = [
    [["--teacher"], /needs a value/],
    [["--teacher", "--arm", "B"], /needs a value/],
    [["--teacher="], /needs a value/],
    [["--arm", "  "], /needs a value/],
    [["--arm", "A", "--arm", "B"], /more than once/],
    [["--room", "x"], /Unknown option "--room"/],
    [["--json=yes"], /takes no value/],
    [["B"], /Unexpected argument at position 1/],
  ];

  for (const [argv, pattern] of cases) {
    assert.throws(() => parseArgs(argv, SPEC), (error: unknown) => error instanceof UsageError && pattern.test(error.message), argv.join(" "));
  }
});

test("parseArgs: error messages never echo the values given", () => {
  assert.throws(() => parseArgs(["SECRET-LOOKING-VALUE"], SPEC), (error: unknown) =>
    error instanceof Error && !error.message.includes("SECRET-LOOKING-VALUE"));
});

// ---- Stats script ------------------------------------------------------------------

function writeDump(name: string, room: string, codec: string, direction: "outbound" | "inbound") {
  const stat = (id: string, type: string, props: Record<string, unknown[]>) => Object.fromEntries(Object.entries(props)
    .map(([prop, values]) => [`${id}-${prop}`, { statsType: type, startTime: 0, endTime: 9000, values: JSON.stringify(values) }]));
  const ten = <T,>(value: T) => Array(10).fill(value);
  const rising = (last: number) => Array.from({ length: 10 }, (_, index) => (last / 9) * index);
  const stream = direction === "outbound"
    ? stat("OT1", "outbound-rtp", { kind: ten("video"), codecId: ten("C1"), frameHeight: ten(720), framesPerSecond: ten(15), bytesSent: rising(1_000_000) })
    : stat("IT1", "inbound-rtp", { kind: ten("video"), codecId: ten("C1"), frameHeight: ten(720), framesDecoded: rising(135) });
  const file = path.join(work, name);

  writeFileSync(file, JSON.stringify({
    PeerConnections: {
      "1-1": { url: `https://meet.example.test/${room}?jwt=NOT-A-REAL-TOKEN`, stats: { ...stream, ...stat("C1", "codec", { mimeType: [`video/${codec}`] }) } },
    },
  }));

  return file;
}

test("stats script: summary and verdict; the dump's token never appears", () => {
  const room = "sl-codec-test-b-1-abcdef";
  const teacher = writeDump("teacher-b.txt", room, "VP8", "outbound");
  const student = writeDump("student-b.txt", room, "VP8", "inbound");

  const text = run(STATS, ["--arm", "B", "--teacher", teacher, "--student", student]);

  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Arm B: .* -> VALID/);
  assert.doesNotMatch(text.stdout + text.stderr, /NOT-A-REAL-TOKEN/);

  const json = run(STATS, ["--arm", "B", "--teacher", teacher, "--student", student, "--room", room, "--json"]);

  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).room, room);
  assert.doesNotMatch(json.stdout, /NOT-A-REAL-TOKEN/);
});

test("stats script: usage errors exit 1 with a clear message", () => {
  const teacher = writeDump("teacher-x.txt", "sl-codec-test-a-1-abcdef", "AV1", "outbound");
  const cases: Array<[string[], RegExp]> = [
    [[], /Usage: --arm/],
    [["--arm", "A"], /Usage: --arm/],
    [["--arm", "A", "--teacher", "--student", teacher], /"--teacher" needs a value/],
    [["--arm", "A", "--teacher", teacher, "--bogus"], /Unknown option "--bogus"/],
    [["--arm", "A,B", "--teacher", teacher], /exactly one arm/],
    [["--arm", "Z", "--teacher", teacher], /Unknown test arm/],
    [["--arm", "A", "--teacher", path.join(work, "missing.txt")], /Cannot read the teacher dump/],
  ];

  for (const [args, pattern] of cases) {
    const result = run(STATS, args);

    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, pattern, args.join(" "));
  }
});

test("stats script: a file that is not a dump is reported, not crashed on", () => {
  const bad = path.join(work, "not-a-dump.txt");

  writeFileSync(bad, "hello");

  const result = run(STATS, ["--arm", "A", "--teacher", bad]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /teacher dump .*Not a JSON file/);
});

// ---- Link generator (fake domain, throwaway secret) ------------------------------------

const FAKE_ENV = {
  JITSI_DOMAIN: "meet.example.test",
  JITSI_ENABLE_JWT_AUTH: "true",
};

test("link generator: verified links for every arm, tokens only in the temp file, never printed", async () => {
  const secret = randomBytes(32).toString("hex");
  const tempDir = mkdtempSync(path.join(work, "links-"));
  const result = run(LINKS, ["--arm", "all"], { ...FAKE_ENV, JITSI_JWT_SECRET: secret }, tempDir);

  assert.equal(result.status, 0, result.stderr);

  // The file: in a new sl-codec-test-* folder under the temp directory.
  const folders = readdirSync(tempDir).filter((name) => name.startsWith("sl-codec-test-"));

  assert.equal(folders.length, 1);

  const file = path.join(tempDir, folders[0], "links.txt");
  const content = readFileSync(file, "utf8");
  const urls = content.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("https://"));

  assert.equal(urls.length, 6, "teacher + student for arms A, B and C");

  const saved = process.env.JITSI_JWT_SECRET;

  process.env.JITSI_JWT_SECRET = secret;

  try {
    for (const url of urls) {
      const parsed = new URL(url);
      const token = parsed.searchParams.get("jwt") ?? "";
      const room = parsed.pathname.slice(1);
      const moderator = content.split("\n")[content.split("\n").findIndex((line) => line.trim() === url) - 1].includes("teacher");

      assert.match(room, /^sl-codec-test-[abc]-[0-9a-z]+-[0-9a-f]{8}$/);
      assert.equal(parsed.host, "meet.example.test");

      // Never printed: neither the token nor the secret, in any output.
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), "token printed");

      const claims = await verifyTestToken(token, { room, moderator });

      assert.equal(claims.lifetimeSeconds, 3600);
    }
  } finally {
    if (saved === undefined) {
      delete process.env.JITSI_JWT_SECRET;
    } else {
      process.env.JITSI_JWT_SECRET = saved;
    }
  }

  assert.ok(!(result.stdout + result.stderr).includes(secret), "secret printed");
  assert.equal((result.stdout.match(/\?jwt=<redacted>#config\./g) ?? []).length, 6);
  assert.match(result.stdout, /does not revoke the links/);

  // Expiry shown in UTC and Asia/Colombo time, with positive minutes left.
  const expiries = result.stdout.match(/expires \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} Asia\/Colombo, in (\d+) min\)/g) ?? [];

  assert.equal(expiries.length, 6, result.stdout);
  expiries.forEach((line) => {
    const minutes = Number(/in (\d+) min/.exec(line)?.[1]);

    assert.ok(minutes >= 59 && minutes <= 60, line);
  });
  assert.doesNotMatch(result.stdout, /EXPIRED/);
  assert.match(content, /expires \S+Z \(\S+ \S+ Asia\/Colombo, in \d+ min\)/);
  assert.equal(new Set(urls.map((url) => new URL(url).pathname)).size, 3, "one fresh room per arm");
});

test("link generator: refuses to run without a usable configuration, writing nothing", () => {
  const secret = randomBytes(32).toString("hex");
  const cases: Array<[string[], Record<string, string>, RegExp]> = [
    [["--arm", "A"], { JITSI_ENABLE_JWT_AUTH: "true", JITSI_JWT_SECRET: secret }, /JITSI_DOMAIN must be/],
    [["--arm", "A"], { JITSI_DOMAIN: "meet.jit.si", JITSI_ENABLE_JWT_AUTH: "true", JITSI_JWT_SECRET: secret }, /JITSI_DOMAIN must be/],
    [["--arm", "A"], { JITSI_DOMAIN: "meet.example.test", JITSI_ENABLE_JWT_AUTH: "false", JITSI_JWT_SECRET: secret }, /JITSI_ENABLE_JWT_AUTH/],
    [["--arm", "A"], FAKE_ENV, /JITSI_JWT_SECRET is not configured/],
    [["--arm", "D"], { ...FAKE_ENV, JITSI_JWT_SECRET: secret }, /Unknown test arm/],
    [["--arm"], { ...FAKE_ENV, JITSI_JWT_SECRET: secret }, /"--arm" needs a value/],
    [["--arms", "A"], { ...FAKE_ENV, JITSI_JWT_SECRET: secret }, /Unknown option "--arms"/],
  ];

  for (const [args, env, pattern] of cases) {
    const tempDir = mkdtempSync(path.join(work, "refused-"));
    const result = run(LINKS, args, env, tempDir);

    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, pattern, args.join(" "));
    assert.ok(!(result.stdout + result.stderr).includes(secret), "secret printed");
    // (tsx keeps its own cache folder in the temp directory too.)
    assert.deepEqual(readdirSync(tempDir).filter((name) => name.startsWith("sl-codec-test-")), [], "no links file written");
    assert.ok(existsSync(tempDir));
  }
});
