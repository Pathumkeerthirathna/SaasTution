/*
 * Unified storage migration, Stage 1: the READ-ONLY inventory CLI's logic
 * (no side effects on import; scripts/storage-inventory.ts is the entry
 * point). See docs/storage-migration-inventory.md.
 *
 *   STORAGE_INVENTORY_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/<name>_test \
 *   npm run storage:inventory -- \
 *     --storage-root=<absolute path to a COPY of the app's storage/ folder> \
 *     [--public-uploads-root=<absolute path to a COPY of public/uploads>] \
 *     [--file-storage-root=<absolute path to a COPY of FILE_STORAGE_ROOT>] \
 *     --out=<absolute path of a NEW .json report> \
 *     --confirm-database=<the database name in the URL>
 *
 * Refuses (before any connection) unless the URL is a loopback PostgreSQL
 * database whose name identifies a local test / development database, and
 * --confirm-database repeats that name. DATABASE_URL and .env are never used.
 * Writes only the two report files, each created exclusively (never
 * overwritten) and never inside the inspected roots.
 *
 * Exit codes: 0 report written, 1 refused / failed, 2 usage error.
 */

import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  checkInventoryDatabaseUrl,
  createIsolatedPrismaClient,
  DATABASE_URL_PROBLEM_MESSAGES,
  INVENTORY_DATABASE_URL_ENV,
  readInventoryRecords,
  type InventoryDatabaseClient,
} from "@/lib/storage-migration/inventory-database";
import { InventoryRootError, isPathWithin, openLegacyRoots } from "@/lib/storage-migration/inventory-filesystem";
import { buildInventoryReport, formatConsoleSummary, formatSummaryFile } from "@/lib/storage-migration/inventory";

type Env = Record<string, string | undefined>;

export type InventoryArgs = { storageRoot: string; publicUploadsRoot: string | null; fileStorageRoot: string | null; out: string; confirmDatabase: string };

export class InventoryUsageError extends Error {}

export const USAGE = [
  "Usage (read-only):",
  `  ${INVENTORY_DATABASE_URL_ENV}=postgresql://<user>:<password>@127.0.0.1:5432/<name>_test npm run storage:inventory -- \\`,
  "    --storage-root=<absolute path to a copy of storage/> [--public-uploads-root=<absolute path to a copy of public/uploads>] \\",
  "    [--file-storage-root=<absolute path to a copy of FILE_STORAGE_ROOT>] \\",
  "    --out=<absolute path of a new .json report> --confirm-database=<database name>",
].join("\n");

const FLAGS = {
  "--storage-root=": "storageRoot",
  "--public-uploads-root=": "publicUploadsRoot",
  "--file-storage-root=": "fileStorageRoot",
  "--out=": "out",
  "--confirm-database=": "confirmDatabase",
} as const;

export function parseInventoryArgs(argv: string[]): InventoryArgs {
  const values: Partial<Record<(typeof FLAGS)[keyof typeof FLAGS], string>> = {};
  for (const arg of argv) {
    const flag = (Object.keys(FLAGS) as Array<keyof typeof FLAGS>).find((prefix) => arg.startsWith(prefix));
    if (!flag) throw new InventoryUsageError(`Unknown argument: ${arg.split("=")[0]}`);
    const key = FLAGS[flag];
    if (values[key] !== undefined) throw new InventoryUsageError(`Repeated argument: ${flag.slice(0, -1)}`);
    const value = arg.slice(flag.length).trim();
    if (!value) throw new InventoryUsageError(`Empty value for ${flag.slice(0, -1)}`);
    values[key] = value;
  }
  for (const required of ["storageRoot", "out", "confirmDatabase"] as const) {
    if (!values[required]) throw new InventoryUsageError(`Missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=`);
  }
  if (!path.isAbsolute(values.out as string) || !(values.out as string).toLowerCase().endsWith(".json")) {
    throw new InventoryUsageError("--out must be an absolute path ending in .json");
  }
  return {
    storageRoot: values.storageRoot as string,
    publicUploadsRoot: values.publicUploadsRoot ?? null,
    fileStorageRoot: values.fileStorageRoot ?? null,
    out: path.resolve(values.out as string),
    confirmDatabase: values.confirmDatabase as string,
  };
}

export type InventoryCliDeps = {
  env: Env;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Loads the PrismaClient class; only called after every check passed. */
  loadPrismaClient: () => Promise<new (options: never) => InventoryDatabaseClient & { $disconnect(): Promise<void> }>;
  now?: () => Date;
};

function describeError(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  // Prisma error codes (P1001 ...) and our own codes only: messages could carry connection details.
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return `${(error as Error).name ?? "Error"} ${code}`;
  return error instanceof Error ? error.name : "unknown error";
}

export async function runStorageInventoryCli(argv: string[], deps: InventoryCliDeps): Promise<number> {
  let args: InventoryArgs;
  try {
    args = parseInventoryArgs(argv);
  } catch (error) {
    if (error instanceof InventoryUsageError) {
      deps.error(error.message);
      deps.error(USAGE);
      return 2;
    }
    throw error;
  }

  // 1. The database target (nothing connects before this passes).
  const target = checkInventoryDatabaseUrl(deps.env[INVENTORY_DATABASE_URL_ENV]);
  if (!target.ok) {
    deps.error(DATABASE_URL_PROBLEM_MESSAGES[target.problem]);
    return 1;
  }
  if (args.confirmDatabase !== target.databaseName) {
    deps.error("Refused: --confirm-database does not match the database name in the URL.");
    return 1;
  }

  // 2. The legacy roots (read-only checks).
  let roots;
  try {
    roots = await openLegacyRoots({ storage: args.storageRoot, publicUploads: args.publicUploadsRoot, fileStorage: args.fileStorageRoot });
  } catch (error) {
    deps.error(error instanceof InventoryRootError ? error.message : `Refused: the legacy roots could not be checked (${describeError(error)}).`);
    return 1;
  }

  // 3. The report files: new, outside the roots, in an existing folder (nothing is created but the two files).
  const summaryPath = args.out.replace(/\.json$/i, ".summary.txt");
  for (const file of [args.out, summaryPath]) {
    if ([roots.storage, roots.publicUploads, roots.fileStorage].some((root) => root !== null && isPathWithin(root, file))) {
      deps.error("Refused: the report must be written outside the inspected roots.");
      return 1;
    }
    if (await lstat(file).catch(() => null)) {
      deps.error("Refused: a report file already exists at that path (reports are never overwritten).");
      return 1;
    }
  }
  const outDir = await lstat(path.dirname(args.out)).catch(() => null);
  if (!outDir || !outDir.isDirectory()) {
    deps.error("Refused: the report folder does not exist (it is not created automatically).");
    return 1;
  }

  // 4. Read the database (one read-only transaction), then the files.
  deps.log(`Reading database "${target.databaseName}" on loopback (read-only transaction)...`);
  let records;
  const Client = await deps.loadPrismaClient();
  const { client } = createIsolatedPrismaClient(Client as never, target.url, deps.env);
  const prisma = client as InventoryDatabaseClient & { $disconnect(): Promise<void> };
  try {
    records = await readInventoryRecords(prisma);
  } catch (error) {
    deps.error(`Database read failed (${describeError(error)}). Nothing was changed.`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  deps.log(`Inspecting ${records.notes.length + records.submissions.length} referenced file(s) and the legacy folders...`);
  const report = await buildInventoryReport({ ...records, roots, database: { databaseName: target.databaseName }, now: deps.now });

  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  await writeFile(summaryPath, formatSummaryFile(report), { flag: "wx" });

  for (const line of formatConsoleSummary(report)) deps.log(line);
  deps.log(`JSON report:  ${args.out}`);
  deps.log(`Summary file: ${summaryPath}`);
  return 0;
}
