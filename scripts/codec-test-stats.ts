/*
 * Isolated Jitsi codec test: summarises the teacher's and the student's
 * chrome://webrtc-internals dumps for one arm and says whether the arm ran
 * as requested (test room, actual codec, the 15 fps condition, and for arm C
 * the raised bitrate cap).
 *
 *   npm run codec:stats -- --arm B --teacher teacher-B.txt --student student-B.txt
 *   (--room <name> picks one run when a dump holds several runs of the arm;
 *    --json for machine-readable output)
 *
 * Local only: reads the two files, prints a report, sends nothing anywhere.
 */

import { readFileSync } from "node:fs";

import { parseArmList } from "./codec-test/arms";
import { optionalValue, parseArgs, UsageError } from "./codec-test/cli";
import { evaluateArm, formatSummary, formatVerdict, summariseDump, type DumpSummary } from "./codec-test/stats";

const USAGE = "Usage: --arm A|B|C --teacher <dump> [--student <dump>] [--room <name>] [--json]";

function load(label: string, file: string): DumpSummary {
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Cannot read the ${label} dump "${file}".`);
  }

  try {
    return summariseDump(text);
  } catch (error) {
    throw new Error(`${label} dump "${file}": ${error instanceof Error ? error.message : "unreadable"}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    "--arm": "value",
    "--teacher": "value",
    "--student": "value",
    "--room": "value",
    "--json": "flag",
  });
  const armArg = optionalValue(args, "--arm");
  const teacherFile = optionalValue(args, "--teacher");
  const studentFile = optionalValue(args, "--student");

  if (!armArg || !teacherFile) {
    throw new UsageError(USAGE);
  }

  const armIds = parseArmList(armArg);

  if (armIds.length !== 1) {
    throw new UsageError("Give exactly one arm per pair of dumps.");
  }

  const teacher = load("teacher", teacherFile);
  const student = studentFile ? load("student", studentFile) : null;
  const verdict = evaluateArm(armIds[0], teacher, student, { room: optionalValue(args, "--room") });

  if (args["--json"]) {
    console.log(JSON.stringify({
      arm: verdict.arm.id,
      room: verdict.room,
      valid: verdict.valid,
      checks: verdict.checks,
      teacher,
      student,
    }, null, 2));
    return;
  }

  console.log(formatSummary("Teacher", teacher));

  if (student) {
    console.log(`\n${formatSummary("Student", student)}`);
  }

  console.log(`\n${formatVerdict(verdict)}`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
