/*
 * Isolated Jitsi codec test: creates a fresh room per test arm and one
 * teacher link (moderator) and one student link (not a moderator) for each.
 *
 *   npm run codec:links -- --arm all     (or --arm A, --arm B,C)
 *
 * Reads JITSI_DOMAIN / JITSI_ENABLE_JWT_AUTH / JITSI_JWT_* from .env. Every
 * token is issued with the app's own generateJitsiToken, then verified: it
 * is limited to its room, expires within an hour and carries only the
 * participant's own permission.
 *
 * The console only ever shows links with the token redacted. The full links
 * go to a new links.txt in a new folder under the OS temp directory (outside
 * the repository); its path is printed.
 * - File permissions: the file is created with mode 0o600, which makes it
 *   owner-only on Linux and macOS. Windows ignores that mode: there the file
 *   gets the temp folder's permissions, which for the default per-user temp
 *   folder (%LOCALAPPDATA%\Temp) normally means this user and administrators.
 * - Deleting links.txt does NOT revoke the tokens: anyone who already has a
 *   link can join that room until the token expires (at most one hour).
 * Never commit or share the file.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ARMS, buildMeetingUrl, buildRoomName, parseArmList, redactJwt, type Role } from "./codec-test/arms";
import { optionalValue, parseArgs } from "./codec-test/cli";
import { formatExpiry } from "./codec-test/time";
import { issueTestToken } from "./codec-test/token";

const PARTICIPANTS: Array<{ role: Role; name: string; moderator: boolean }> = [
  { role: "teacher", name: "Codec Test Teacher", moderator: true },
  { role: "student", name: "Codec Test Student", moderator: false },
];

async function main() {
  const args = parseArgs(process.argv.slice(2), { "--arm": "value" });
  const armIds = parseArmList(optionalValue(args, "--arm"));
  const domain = process.env.JITSI_DOMAIN?.trim() ?? "";

  if (!domain || domain === "meet.jit.si") {
    throw new Error("JITSI_DOMAIN must be the self-hosted Jitsi domain (run with --env-file=.env).");
  }

  if (process.env.JITSI_ENABLE_JWT_AUTH?.trim().toLowerCase() !== "true") {
    throw new Error("JITSI_ENABLE_JWT_AUTH is not \"true\": the test rooms would not get tokens.");
  }

  const fileLines = [
    "SL Classroom - isolated Jitsi codec test links",
    `Created ${new Date().toISOString()}. Each link works only for its own room and expires within an hour.`,
    "Open each arm's teacher link on the teacher computer (teacher first) and its student link on the student device.",
    "Do not commit or share this file. Deleting it does not revoke the links: they work until they expire.",
    "",
  ];
  let latestExpiry = new Date(0);

  console.log(`Jitsi domain: ${domain}`);

  for (const armId of armIds) {
    const arm = ARMS[armId];
    const room = buildRoomName(armId, Date.now(), randomBytes(4).toString("hex"));

    console.log(`\nArm ${arm.id}: ${arm.label}`);
    console.log(`  room: ${room}`);
    fileLines.push(`Arm ${arm.id}: ${arm.label}`, `  room: ${room}`);

    for (const participant of PARTICIPANTS) {
      const { token, claims } = await issueTestToken({
        room,
        name: participant.name,
        moderator: participant.moderator,
        jitsiDomain: domain,
      });
      const url = buildMeetingUrl({ domain, room, jwt: token, arm, role: participant.role });

      if (claims.expiresAt > latestExpiry) {
        latestExpiry = claims.expiresAt;
      }

      console.log(
        `  ${participant.role}: token verified (room ${claims.room}, moderator ${claims.moderator}, ` +
        `expires ${formatExpiry(claims.expiresAt)}, lifetime ${claims.lifetimeSeconds}s)`
      );
      console.log(`    ${redactJwt(url)}`);
      fileLines.push(`  ${participant.role} (expires ${formatExpiry(claims.expiresAt)}):`, `    ${url}`);
    }

    fileLines.push("");
  }

  const directory = mkdtempSync(path.join(tmpdir(), "sl-codec-test-"));
  const file = path.join(directory, "links.txt");

  // 0o600: owner-only on Linux / macOS; ignored on Windows (see the header).
  writeFileSync(file, fileLines.join("\n"), { encoding: "utf8", mode: 0o600 });

  console.log(`\nFull links (with tokens) written to:\n  ${file}`);
  console.log(
    process.platform === "win32"
      ? "Windows: the file has your temp folder's permissions (normally you and administrators)."
      : "The file is readable by your user only."
  );
  console.log(`Deleting the file does not revoke the links: they stay valid until ${formatExpiry(latestExpiry)}.`);
  console.log("Do not commit or share the file; delete it after the test.");
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
