/*
 * Unified storage migration, Stage 1 (inventory): database safety and the
 * read-only record reader.
 *
 * Safety layers, in order:
 *   1. checkInventoryDatabaseUrl: only a postgres URL to a LOOPBACK host
 *      (localhost, 127.0.0.1, ::1) whose database name identifies a local
 *      test / development database, with no query parameter that could
 *      redirect the connection (host=, hostaddr=, ...). Messages never echo
 *      the URL or its credentials.
 *   2. createIsolatedPrismaClient: the URL is passed explicitly as the
 *      datasource; the generated Prisma client loads the project .env in its
 *      constructor, so every variable it adds to process.env is removed
 *      straight away (nothing from .env is used or left behind).
 *   3. readInventoryRecords: ONE transaction that first becomes
 *      REPEATABLE READ + READ ONLY (PostgreSQL then rejects any write), checks
 *      that with SHOW, and reads through a wrapper exposing findMany only.
 *
 * No module-level side effects; nothing here imports lib/prisma.
 */

export const INVENTORY_DATABASE_URL_ENV = "STORAGE_INVENTORY_DATABASE_URL";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Parameters that are harmless; anything else (host, hostaddr, service, sslrootcert ...) is refused. */
const ALLOWED_PARAMS = new Set(["schema", "connect_timeout", "sslmode", "application_name"]);
/** The name must contain a whole "test" / "testing" / "dev" / "development" / "local" token. */
const LOCAL_NAME = /(^|[^a-z0-9])(test|testing|dev|development|local)([^a-z0-9]|$)/i;
const DATABASE_NAME = /^[A-Za-z0-9_.-]{1,63}$/;

export type DatabaseUrlProblem =
  | "MISSING"
  | "NOT_A_URL"
  | "NOT_POSTGRES"
  | "NOT_LOOPBACK"
  | "MULTIPLE_HOSTS"
  | "UNSAFE_PARAMETER"
  | "INVALID_DATABASE_NAME"
  | "NOT_A_LOCAL_DATABASE_NAME";

export type DatabaseUrlCheck =
  | { ok: true; url: string; databaseName: string; host: "loopback" }
  | { ok: false; problem: DatabaseUrlProblem };

export const DATABASE_URL_PROBLEM_MESSAGES: Record<DatabaseUrlProblem, string> = {
  MISSING: `${INVENTORY_DATABASE_URL_ENV} is not set. Set it to a local, disposable test database (it is never read from .env).`,
  NOT_A_URL: "The database URL could not be parsed.",
  NOT_POSTGRES: "The database URL must use postgresql:// or postgres://.",
  NOT_LOOPBACK: "Refused: the database host must be localhost, 127.0.0.1 or ::1 (remote databases are never used).",
  MULTIPLE_HOSTS: "Refused: the database URL names more than one host.",
  UNSAFE_PARAMETER: "Refused: the database URL contains a parameter that could redirect the connection.",
  INVALID_DATABASE_NAME: "Refused: the database name is missing or invalid.",
  NOT_A_LOCAL_DATABASE_NAME: 'Refused: the database name must contain "test", "testing", "dev", "development" or "local" as a separate word (e.g. slc_inventory_test).',
};

export function checkInventoryDatabaseUrl(raw: string | undefined): DatabaseUrlCheck {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, problem: "MISSING" };
  const value = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(value)) return { ok: false, problem: "NOT_POSTGRES" };
  // "user@a,b/db": libpq multi-host syntax. WHATWG URL rejects or mangles it, so check first.
  const authority = value.replace(/^postgres(ql)?:\/\//i, "").split(/[/?#]/)[0];
  if (authority.slice(authority.lastIndexOf("@") + 1).includes(",")) return { ok: false, problem: "MULTIPLE_HOSTS" };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, problem: "NOT_A_URL" };
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return { ok: false, problem: "NOT_POSTGRES" };
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return { ok: false, problem: "NOT_LOOPBACK" };
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key.toLowerCase())) return { ok: false, problem: "UNSAFE_PARAMETER" };
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return { ok: false, problem: "INVALID_DATABASE_NAME" };
  }
  if (!DATABASE_NAME.test(databaseName)) return { ok: false, problem: "INVALID_DATABASE_NAME" };
  if (!LOCAL_NAME.test(databaseName)) return { ok: false, problem: "NOT_A_LOCAL_DATABASE_NAME" };

  return { ok: true, url: value, databaseName, host: "loopback" };
}

// ---- Client creation without leaking .env ---------------------------------------------------------------

type Env = Record<string, string | undefined>;
type ClientConstructor<C> = new (options: { datasources: { db: { url: string } }; log: never[]; errorFormat: "minimal" }) => C;

/**
 * Constructs the client with the explicit URL, then removes every variable
 * the constructor added to `env` (Prisma loads the project .env there) and
 * restores any it changed. Returns which variables were dropped (names only).
 */
export function createIsolatedPrismaClient<C>(Client: ClientConstructor<C>, url: string, env: Env = process.env): { client: C; droppedVariables: number } {
  const before = new Map(Object.entries(env));
  const client = new Client({ datasources: { db: { url } }, log: [], errorFormat: "minimal" });
  let dropped = 0;
  for (const key of Object.keys(env)) {
    if (!before.has(key)) {
      delete env[key];
      dropped++;
    } else if (env[key] !== before.get(key)) {
      env[key] = before.get(key);
    }
  }
  return { client, droppedVariables: dropped };
}

// ---- Read-only reading ---------------------------------------------------------------------------------

export type InventoryNoteRow = {
  id: string;
  lectureId: string;
  fileUrl: string;
  /** Unified storage (Stage 2): the new-storage key and digest; null for a legacy-only row. */
  storageKey: string | null;
  sha256: string | null;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  status: number;
  lecture: { id: string; status: number; classId: string; class: { teacherId: string; status: number } | null } | null;
};

export type InventorySubmissionRow = {
  id: string;
  assignmentId: string;
  fileUrl: string;
  storageKey: string | null;
  sha256: string | null;
  mimeType: string;
  sizeBytes: number;
  assignment: {
    id: string;
    status: number;
    lectureId: string;
    lecture: { id: string; status: number; classId: string; class: { teacherId: string; status: number } | null } | null;
  } | null;
};

type FindMany = (args: Record<string, unknown>) => Promise<unknown[]>;

/** The transaction client as this module uses it (Prisma's, or a test fake). */
export type InventoryTransactionClient = {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
  note: { findMany: FindMany };
  assignmentSubmission: { findMany: FindMany };
};

export type InventoryDatabaseClient = {
  $transaction<T>(fn: (tx: InventoryTransactionClient) => Promise<T>, options: { maxWait: number; timeout: number }): Promise<T>;
};

/** The only statements sent besides Prisma's own SELECTs. Neither changes data. */
export const READ_ONLY_TRANSACTION_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";
export const SHOW_READ_ONLY_SQL = "SHOW transaction_read_only";
export const SHOW_ISOLATION_SQL = "SHOW transaction_isolation";

export class InventoryDatabaseError extends Error {
  constructor(readonly code: "NOT_READ_ONLY" | "NOT_REPEATABLE_READ" | "WRITE_ATTEMPTED") {
    super(code === "WRITE_ATTEMPTED" ? "A write was attempted through the read-only inventory client." : "The inventory transaction is not read-only.");
    this.name = "InventoryDatabaseError";
  }
}

/** findMany only: any other model method (create, update, delete, upsert, ...) throws before reaching Prisma. */
export function readOnlyModel(model: { findMany: FindMany }): { findMany: FindMany } {
  return new Proxy(model, {
    get(target, property) {
      if (property === "findMany") return target.findMany.bind(target);
      throw new InventoryDatabaseError("WRITE_ATTEMPTED");
    },
  });
}

function firstValue(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object" || rows[0] === null) return null;
  const value = Object.values(rows[0] as Record<string, unknown>)[0];
  return typeof value === "string" ? value.toLowerCase() : null;
}

const OWNER_SELECT = { select: { id: true, status: true, classId: true, class: { select: { teacherId: true, status: true } } } } as const;

export const NOTE_SELECT = {
  id: true,
  lectureId: true,
  fileUrl: true,
  storageKey: true,
  sha256: true,
  mimeType: true,
  sizeBytes: true,
  kind: true,
  status: true,
  lecture: OWNER_SELECT,
} as const;

export const SUBMISSION_SELECT = {
  id: true,
  assignmentId: true,
  fileUrl: true,
  storageKey: true,
  sha256: true,
  mimeType: true,
  sizeBytes: true,
  assignment: { select: { id: true, status: true, lectureId: true, lecture: OWNER_SELECT } },
} as const;

export const INVENTORY_PAGE_SIZE = 1000;

async function readAll(model: { findMany: FindMany }, select: Record<string, unknown>, pageSize: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = (await model.findMany({
      select,
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as Array<{ id: string }>;
    rows.push(...page);
    if (page.length < pageSize) return rows;
    cursor = page[page.length - 1].id;
  }
}

/**
 * Every Note and AssignmentSubmission row (soft-deleted ones included), read
 * in one REPEATABLE READ, READ ONLY transaction so all pages are one
 * consistent snapshot.
 */
export async function readInventoryRecords(
  client: InventoryDatabaseClient,
  options: { pageSize?: number } = {}
): Promise<{ notes: InventoryNoteRow[]; submissions: InventorySubmissionRow[] }> {
  const pageSize = options.pageSize ?? INVENTORY_PAGE_SIZE;
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(READ_ONLY_TRANSACTION_SQL);
      if (firstValue(await tx.$queryRawUnsafe(SHOW_READ_ONLY_SQL)) !== "on") throw new InventoryDatabaseError("NOT_READ_ONLY");
      if (firstValue(await tx.$queryRawUnsafe(SHOW_ISOLATION_SQL)) !== "repeatable read") throw new InventoryDatabaseError("NOT_REPEATABLE_READ");
      const notes = (await readAll(readOnlyModel(tx.note), NOTE_SELECT, pageSize)) as InventoryNoteRow[];
      const submissions = (await readAll(readOnlyModel(tx.assignmentSubmission), SUBMISSION_SELECT, pageSize)) as InventorySubmissionRow[];
      return { notes, submissions };
    },
    { maxWait: 10_000, timeout: 10 * 60_000 }
  );
}
