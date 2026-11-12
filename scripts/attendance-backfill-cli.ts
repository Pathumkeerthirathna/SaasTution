/*
 * Historical attendance backfill: the operator CLI's logic (argument parsing,
 * confirmation guards, per-lecture reporting). No side effects on import;
 * scripts/attendance-backfill.ts is the entry point. See
 * docs/lecture-attendance.md ("Historical backfill").
 *
 * Dry run (default; read-only):
 *   npm run attendance:backfill -- --lecture=<id>
 *   npm run attendance:backfill -- --class=<id>
 *   npm run attendance:backfill -- --before=2026-08-15T00:00:00+05:30
 *
 * Execute (one short transaction per student):
 *   npm run attendance:backfill -- --lecture=<id> --execute \
 *     --confirm-backfill-historical-attendance --confirm-database=<database name>
 *
 * Exactly one scope is required (never "all lectures"). --confirm-database
 * must equal the database name in DATABASE_URL. Output: lecture ids and
 * counts only — never a connection string, credential, student name or id.
 * Exit codes: 0 done, 1 refused / incomplete / failed, 2 usage error.
 */

import { parseAttendanceInstant } from "@/lib/attendance/config";
import { AppError } from "@/lib/error-handler";
import {
  backfillLectureAttendance,
  listBackfillLectures,
  type BackfillLectureResult,
  type BackfillScope,
} from "@/services/lecture-attendance-backfill-service";

export const EXECUTE_FLAG = "--execute";
export const DRY_RUN_FLAG = "--dry-run";
export const CONFIRM_FLAG = "--confirm-backfill-historical-attendance";
export const DATABASE_FLAG = "--confirm-database=";
const SCOPE_FLAGS = { "--lecture=": "lecture", "--class=": "class", "--before=": "before" } as const;

/** Ids: cuid / uuid-like only (also keeps a pasted secret from being echoed or used). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;
/** PostgreSQL database names as they appear in DATABASE_URL. */
const DATABASE_PATTERN = /^[A-Za-z0-9_.-]{1,63}$/;

/** Refusals of one lecture that do not stop a class / date run. */
const LECTURE_REFUSALS = new Set(["LECTURE_NOT_FOUND", "LECTURE_CANCELLED", "ATTENDANCE_REGISTER_FINALIZED", "ATTENDANCE_LECTURE_LIVE"]);

type Env = Record<string, string | undefined>;

export class BackfillUsageError extends Error {}

export type BackfillArgs = {
  execute: boolean;
  confirmed: boolean;
  database: string | null;
  scope: BackfillScope;
};

/**
 * Strict parsing. Refused (usage error, the value never echoed): unknown
 * arguments, any flag given twice, --execute with --dry-run, zero or several
 * scopes, malformed ids, a --before without an explicit offset (Z or ±HH:MM),
 * an empty / malformed database name, and confirmation flags without
 * --execute.
 */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const seen = new Set<string>();
  const once = (flag: string) => {
    if (seen.has(flag)) throw new BackfillUsageError(`${flag.replace(/=$/, "")} was given more than once.`);
    seen.add(flag);
  };

  let execute = false;
  let dryRun = false;
  let confirmed = false;
  let database: string | null = null;
  const scopes: BackfillScope[] = [];

  for (const arg of argv) {
    if (arg === EXECUTE_FLAG) {
      once(arg);
      execute = true;
    } else if (arg === DRY_RUN_FLAG) {
      once(arg);
      dryRun = true;
    } else if (arg === CONFIRM_FLAG) {
      once(arg);
      confirmed = true;
    } else if (arg.startsWith(DATABASE_FLAG)) {
      once(DATABASE_FLAG);
      const value = arg.slice(DATABASE_FLAG.length);
      if (!DATABASE_PATTERN.test(value)) throw new BackfillUsageError(`${DATABASE_FLAG}<name> needs a valid database name.`);
      database = value;
    } else {
      const flag = (Object.keys(SCOPE_FLAGS) as (keyof typeof SCOPE_FLAGS)[]).find((f) => arg.startsWith(f));
      // Never echo an unknown argument: it might be a secret pasted by mistake.
      if (!flag) throw new BackfillUsageError("Unknown argument (value not shown).");
      once(flag);
      const value = arg.slice(flag.length);
      const kind = SCOPE_FLAGS[flag];
      if (kind === "before") {
        const before = parseAttendanceInstant(value);
        if (!before) {
          throw new BackfillUsageError("--before needs an ISO 8601 instant with an explicit offset, e.g. 2026-08-15T00:00:00+05:30 or ...Z.");
        }
        scopes.push({ kind: "before", before });
      } else {
        if (!ID_PATTERN.test(value)) throw new BackfillUsageError(`${flag}<id> needs a valid id.`);
        scopes.push(kind === "lecture" ? { kind: "lecture", lectureId: value } : { kind: "class", classId: value });
      }
    }
  }

  if (execute && dryRun) throw new BackfillUsageError(`${EXECUTE_FLAG} and ${DRY_RUN_FLAG} cannot be combined.`);
  if (scopes.length === 0) throw new BackfillUsageError("A scope is required: exactly one of --lecture=<id>, --class=<id>, --before=<instant>.");
  if (scopes.length > 1) throw new BackfillUsageError("Give exactly one scope: --lecture=<id>, --class=<id> or --before=<instant>.");
  if (!execute && (confirmed || database !== null)) {
    throw new BackfillUsageError(`Confirmation flags are only used with ${EXECUTE_FLAG}; a dry run needs none.`);
  }
  return { execute, confirmed, database, scope: scopes[0] };
}

/** host:port/database of DATABASE_URL — never the user name or password. */
export function targetDatabase(databaseUrl: string | undefined): { label: string; name: string } {
  if (!databaseUrl) throw new BackfillUsageError("DATABASE_URL is not set.");
  try {
    const url = new URL(databaseUrl);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!name) throw new Error("no database");
    return { label: `${url.hostname}${url.port ? `:${url.port}` : ""}/${name}`, name };
  } catch {
    throw new BackfillUsageError("DATABASE_URL is not a valid database URL.");
  }
}

/** Execute needs --confirm-backfill-historical-attendance AND --confirm-database matching DATABASE_URL. */
export function assertExecutionConfirmed(args: BackfillArgs, target: { name: string }) {
  if (!args.execute) return;
  if (!args.confirmed) throw new BackfillUsageError(`${EXECUTE_FLAG} also needs ${CONFIRM_FLAG}.`);
  if (args.database === null) throw new BackfillUsageError(`${EXECUTE_FLAG} also needs ${DATABASE_FLAG}<name>.`);
  if (args.database !== target.name) {
    throw new BackfillUsageError(`${DATABASE_FLAG}<name> does not match the DATABASE_URL database. Nothing was changed.`);
  }
}

function describeScope(scope: BackfillScope) {
  if (scope.kind === "lecture") return `lecture ${scope.lectureId}`;
  if (scope.kind === "class") return `class ${scope.classId}`;
  return `lectures starting before ${scope.before.toISOString()}`;
}

function lectureLine(r: BackfillLectureResult, execute: boolean) {
  return (
    `  lecture ${r.lectureId}: students ${r.students}, ${execute ? "created" : "would create"} ${r.created}` +
    ` (joined late ${r.createdLateJoin}), existing ${r.existing}, ineligible ${r.ineligible}, unknown ${r.unknown},` +
    ` inactive ${r.inactive}, skipped ${r.skipped}${execute ? `, busy ${r.busy}` : ""}` +
    `${r.stoppedBecause ? ` — STOPPED (${r.stoppedBecause})` : ""}`
  );
}

export type BackfillCliDeps = {
  databaseUrl: string | undefined;
  env: Env;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** Runs the CLI; returns the exit code. Usage errors happen before any database access. */
export async function runAttendanceBackfillCli(argv: readonly string[], deps: BackfillCliDeps): Promise<number> {
  let args: BackfillArgs;
  let target: { label: string; name: string };
  try {
    args = parseBackfillArgs(argv);
    target = targetDatabase(deps.databaseUrl);
    assertExecutionConfirmed(args, target);
  } catch (error) {
    if (error instanceof BackfillUsageError) {
      deps.error(`Usage error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const execute = args.execute;
  deps.log(`Attendance backfill — ${execute ? "EXECUTE" : "DRY RUN (no writes)"}`);
  deps.log(`  target database: ${target.label}`);
  deps.log(`  scope: ${describeScope(args.scope)}`);

  let lectureIds: string[];
  try {
    lectureIds = await listBackfillLectures(args.scope);
  } catch (error) {
    deps.error(`Failed to list lectures (${error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown error"}).`);
    return 1;
  }
  if (lectureIds.length === 0) {
    deps.log("No lectures in this scope.");
    return 0;
  }

  const totals = { lectures: 0, refused: 0, created: 0, existing: 0, busy: 0, stopped: 0 };
  let exitCode = 0;
  for (const lectureId of lectureIds) {
    try {
      const result = await backfillLectureAttendance({ lectureId, mode: execute ? "execute" : "dry-run" }, { env: deps.env });
      totals.lectures += 1;
      totals.created += result.created;
      totals.existing += result.existing;
      totals.busy += result.busy;
      if (result.stoppedBecause) totals.stopped += 1;
      deps.log(lectureLine(result, execute));
    } catch (error) {
      if (error instanceof AppError && LECTURE_REFUSALS.has(error.code ?? "")) {
        totals.refused += 1;
        deps.log(`  lecture ${lectureId}: refused (${error.code})`);
        if (args.scope.kind === "lecture") exitCode = 1;
        continue;
      }
      // Configuration (503) or an unexpected failure: stop. Code / name only
      // (a message could carry row details). Students already committed stay.
      const label = error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown error";
      deps.error(`  lecture ${lectureId}: failed (${label}). Stopping; earlier lectures are kept. Re-running is safe.`);
      return 1;
    }
  }

  deps.log(
    `Total: lectures ${totals.lectures}, refused ${totals.refused}, ${execute ? "created" : "would create"} ${totals.created},` +
      ` existing ${totals.existing}${execute ? `, busy ${totals.busy}` : ""}`
  );
  if (totals.busy > 0 || totals.stopped > 0) {
    deps.log("Incomplete: some students were busy or a lecture changed. Run the same command again (it is idempotent).");
    exitCode = 1;
  } else if (!execute) {
    deps.log("Dry run only: nothing was changed.");
  }
  return exitCode;
}
