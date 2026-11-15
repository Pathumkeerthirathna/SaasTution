/*
 * Unified storage migration, Stage 1: the READ-ONLY inventory tool
 * (lib/storage-migration/*, scripts/storage-inventory*.ts).
 *
 *   npm run test:storage-migration
 *
 * Real filesystem in fresh temporary folders (never the repository's
 * storage/); the database is an in-memory fake that records every call. No
 * real database is used here (see inventory.db.test.cjs). Symbolic-link cases
 * use junctions / links where the platform allows and are skipped otherwise.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const DB = require(path.join(root, "lib", "storage-migration", "inventory-database.ts"));
const FSI = require(path.join(root, "lib", "storage-migration", "inventory-filesystem.ts"));
const INV = require(path.join(root, "lib", "storage-migration", "inventory.ts"));
const CLI = require(path.join(root, "scripts", "storage-inventory-cli.ts"));

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const A1 = "bbbbbbbb-0000-4000-8000-000000000001";

function tempBase() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "inv-"));
}

function put(dir, relative, content) {
  const file = path.join(dir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const lecture = (id, teacherId, { status = 0, classStatus = 0 } = {}) => ({ id, status, classId: `class-${teacherId}`, class: { teacherId, status: classStatus } });
const note = (id, fileUrl, sizeBytes, { lectureId = L1, teacherId = T1, status = 0, lectureStatus = 0, storageKey = null, sha256 = null } = {}) => ({
  id, lectureId, fileUrl, storageKey, sha256, mimeType: "application/pdf", sizeBytes, kind: "NOTE", status, lecture: lecture(lectureId, teacherId, { status: lectureStatus }),
});
const submission = (id, fileUrl, sizeBytes, { assignmentId = A1, lectureId = L1, teacherId = T1, assignmentStatus = 0, storageKey = null, sha256 = null } = {}) => ({
  id, assignmentId, fileUrl, storageKey, sha256, mimeType: "application/pdf", sizeBytes, assignment: { id: assignmentId, status: assignmentStatus, lectureId, lecture: lecture(lectureId, teacherId) },
});

/** Every file and directory below `dir` with size, mtime and hash (to prove nothing changed). */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      const info = fs.lstatSync(p);
      if (entry.isSymbolicLink()) out.push(["link", p]);
      else if (entry.isDirectory()) {
        out.push(["dir", p, info.mtimeMs]);
        walk(p);
      } else out.push(["file", p, info.size, info.mtimeMs, sha(fs.readFileSync(p))]);
    }
  };
  walk(dir);
  return out;
}

const byId = (report, id) => report.records.find((r) => r.recordId === id);

// ---- Database URL safety ------------------------------------------------------------------------------

test("database URL: only loopback PostgreSQL with a local test / dev database name", () => {
  const ok = [
    "postgresql://u:p@localhost:5432/slc_inventory_test",
    "postgres://u@127.0.0.1/saas-dev",
    "postgresql://u:p@[::1]:5432/local_copy",
    "postgresql://u:p@127.0.0.1:5432/inventory_testing?schema=public&connect_timeout=5",
  ];
  for (const url of ok) assert.equal(DB.checkInventoryDatabaseUrl(url).ok, true, url);

  const refused = {
    "": "MISSING",
    "mysql://u@localhost/x_test": "NOT_POSTGRES",
    "postgresql://u:p@ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/neondb_test": "NOT_LOOPBACK",
    "postgresql://u:p@10.0.0.5:5432/slc_test": "NOT_LOOPBACK",
    "postgresql://u:p@localhost.example.com/slc_test": "NOT_LOOPBACK",
    "postgresql://u:p@127.0.0.2/slc_test": "NOT_LOOPBACK",
    "postgresql://u:p@localhost,db.example.com/slc_test": "MULTIPLE_HOSTS",
    "postgresql://u:p@localhost/slc_test?host=db.example.com": "UNSAFE_PARAMETER",
    "postgresql://u:p@localhost/slc_test?hostaddr=10.0.0.5": "UNSAFE_PARAMETER",
    "postgresql://u:p@localhost/": "INVALID_DATABASE_NAME",
    "postgresql://u:p@localhost/slclassroom": "NOT_A_LOCAL_DATABASE_NAME",
    "postgresql://u:p@localhost/production": "NOT_A_LOCAL_DATABASE_NAME",
    "postgresql://u:p@localhost/latest": "NOT_A_LOCAL_DATABASE_NAME",
    "postgresql://u:p@localhost/devices": "NOT_A_LOCAL_DATABASE_NAME",
  };
  for (const [url, problem] of Object.entries(refused)) {
    const result = DB.checkInventoryDatabaseUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.problem, problem, url);
  }
  // Fixed texts: never a host, user or password.
  for (const message of Object.values(DB.DATABASE_URL_PROBLEM_MESSAGES)) assert.doesNotMatch(message, /@|:\/\/\w/);
});

test("the Prisma client is created with the explicit URL, and variables loaded from .env are removed", () => {
  const env = { KEEP: "1", DATABASE_URL: undefined };
  let options;
  class FakeClient {
    constructor(o) {
      options = o;
      env.DATABASE_URL = "postgresql://remote-from-dotenv/neondb"; // what Prisma's .env loading would add
      env.SECRET_FROM_DOTENV = "x";
      env.KEEP = "changed";
    }
  }
  delete env.DATABASE_URL;
  const { droppedVariables } = DB.createIsolatedPrismaClient(FakeClient, "postgresql://u@127.0.0.1/a_test", env);
  assert.deepEqual(options.datasources, { db: { url: "postgresql://u@127.0.0.1/a_test" } });
  assert.deepEqual(env, { KEEP: "1" });
  assert.equal(droppedVariables, 2);
});

// ---- Read-only database reading ----------------------------------------------------------------------

function fakeDatabase({ notes = [], submissions = [], readOnly = "on", isolation = "repeatable read" } = {}) {
  const calls = [];
  const page = (rows) => async (args) => {
    calls.push(["findMany", args.take, args.cursor?.id ?? null]);
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    const start = args.cursor ? sorted.findIndex((r) => r.id === args.cursor.id) + (args.skip ?? 0) : 0;
    return sorted.slice(start, start + args.take);
  };
  const tx = {
    $executeRawUnsafe: async (sql) => calls.push(["execute", sql]),
    $queryRawUnsafe: async (sql) => {
      calls.push(["query", sql]);
      return sql === DB.SHOW_READ_ONLY_SQL ? [{ transaction_read_only: readOnly }] : [{ transaction_isolation: isolation }];
    },
    note: { findMany: page(notes), create: async () => calls.push(["WRITE"]), update: async () => calls.push(["WRITE"]) },
    assignmentSubmission: { findMany: page(submissions), deleteMany: async () => calls.push(["WRITE"]) },
  };
  return {
    calls,
    client: {
      $transaction: async (fn, options) => {
        calls.push(["transaction", options.timeout > 0]);
        return fn(tx);
      },
    },
    tx,
  };
}

test("records are read in one READ ONLY, REPEATABLE READ transaction, all pages, soft-deleted rows included", async () => {
  const notes = Array.from({ length: 5 }, (_, i) => note(`n${i}`, `lectures/${L1}/f${i}.pdf`, 1, { status: i % 2 }));
  const db = fakeDatabase({ notes, submissions: [submission("s1", `assignments/${A1}/x.pdf`, 1)] });
  const result = await DB.readInventoryRecords(db.client, { pageSize: 2 });
  assert.equal(result.notes.length, 5);
  assert.equal(result.notes.filter((n) => n.status === 1).length, 2, "soft-deleted notes are read too");
  assert.equal(result.submissions.length, 1);
  assert.deepEqual(db.calls.slice(0, 4), [["transaction", true], ["execute", DB.READ_ONLY_TRANSACTION_SQL], ["query", DB.SHOW_READ_ONLY_SQL], ["query", DB.SHOW_ISOLATION_SQL]]);
  assert.deepEqual(
    db.calls.filter((c) => c[0] === "findMany").map((c) => c[2]),
    [null, "n1", "n3", null],
    "cursor pagination over notes, then submissions"
  );
  assert.ok(!db.calls.some((c) => c[0] === "WRITE"));
  assert.match(DB.READ_ONLY_TRANSACTION_SQL, /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
});

test("the read stops when the transaction is not read-only; the model wrapper allows findMany only", async () => {
  await assert.rejects(DB.readInventoryRecords(fakeDatabase({ readOnly: "off" }).client), { code: "NOT_READ_ONLY" });
  await assert.rejects(DB.readInventoryRecords(fakeDatabase({ isolation: "read committed" }).client), { code: "NOT_REPEATABLE_READ" });

  // The model wrapper the reader uses: findMany passes, everything else throws before reaching the client.
  const db = fakeDatabase({ notes: [note("n1", "lectures/x/a.pdf", 1)] });
  const wrapped = DB.readOnlyModel(db.tx.note);
  assert.equal((await wrapped.findMany({ take: 10 })).length, 1);
  for (const method of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "$executeRaw"]) {
    assert.throws(() => wrapped[method], { code: "WRITE_ATTEMPTED" }, method);
  }
  assert.ok(!db.calls.some((c) => c[0] === "WRITE"));
});

// ---- Filesystem inventory ------------------------------------------------------------------------------

async function fixture(t) {
  const base = tempBase();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const storage = path.join(base, "storage");
  const uploads = path.join(base, "public-uploads");
  fs.mkdirSync(storage);
  fs.mkdirSync(uploads);
  fs.mkdirSync(path.join(base, "outside"));
  return { base, storage, uploads };
}

test("inventory: sizes, hashes, missing files, size mismatches, /uploads/ references, folder mismatch", async (t) => {
  const f = await fixture(t);
  put(f.storage, `lectures/${L1}/good.pdf`, "good-bytes");
  put(f.storage, `lectures/${L1}/wrongsize.pdf`, "12345");
  put(f.storage, `lectures/${L2}/misplaced.pdf`, "m");
  put(f.storage, `assignments/${A1}/sub.pdf`, "submission");
  put(f.uploads, "old-note.pdf", "legacy");
  const roots = await FSI.openLegacyRoots({ storage: f.storage, publicUploads: f.uploads });

  const report = await INV.buildInventoryReport({
    roots,
    database: { databaseName: "slc_test" },
    notes: [
      note("n-good", `lectures/${L1}/good.pdf`, 10),
      note("n-size", `lectures/${L1}/wrongsize.pdf`, 999),
      note("n-missing", `lectures/${L1}/gone.pdf`, 3),
      note("n-uploads", "/uploads/old-note.pdf", 6),
      note("n-misplaced", `lectures/${L2}/misplaced.pdf`, 1, { lectureId: L1 }),
    ],
    submissions: [submission("s-good", `assignments/${A1}/sub.pdf`, 10)],
  });

  const good = byId(report, "n-good");
  assert.equal(good.fileExists, true);
  assert.equal(good.actualSizeBytes, 10);
  assert.equal(good.sizeMatches, true);
  assert.equal(good.sha256, sha("good-bytes"));
  assert.equal(good.teacherId, T1);
  assert.equal(good.resolvedRelativePath, `lectures/${L1}/good.pdf`);
  assert.deepEqual(good.issues, []);
  assert.equal(good.needsInvestigation, false);

  assert.deepEqual(byId(report, "n-size").issues, ["SIZE_MISMATCH"]);
  assert.equal(byId(report, "n-size").sizeMatches, false);
  assert.deepEqual(byId(report, "n-missing").issues, ["FILE_MISSING"]);
  assert.equal(byId(report, "n-missing").sha256, null);

  const legacy = byId(report, "n-uploads");
  assert.equal(legacy.legacyUploadsReference, true);
  assert.equal(legacy.resolvedRoot, "publicUploads");
  assert.equal(legacy.fileExists, true);
  assert.deepEqual(legacy.issues, ["LEGACY_UPLOADS_REFERENCE"], "informational only");
  assert.equal(legacy.needsInvestigation, false);

  assert.ok(byId(report, "n-misplaced").issues.includes("FOLDER_MISMATCH"));

  const s = report.summary;
  assert.equal(s.notes.total, 5);
  assert.equal(s.submissions.total, 1);
  assert.equal(s.existingFiles, 5);
  assert.equal(s.missingFiles, 1);
  assert.equal(s.sizeMismatches, 1);
  assert.equal(s.legacyUploadsReferences, 1);
  assert.equal(s.bytesByResourceType.submissions.bytes, 10);
  assert.equal(s.bytesByResourceType.notes.bytes, 10 + 5 + 6 + 1);
  assert.deepEqual(report.manualInvestigation.map((m) => m.recordId).sort(), ["n-misplaced", "n-missing", "n-size"]);
});

test("a /uploads/ reference without a configured public uploads root is reported, not guessed; submissions never use public/uploads", async (t) => {
  const f = await fixture(t);
  const roots = await FSI.openLegacyRoots({ storage: f.storage });
  const report = await INV.buildInventoryReport({
    roots,
    database: { databaseName: "slc_test" },
    notes: [note("n", "/uploads/x.pdf", 1)],
    submissions: [submission("s", "/uploads/y.pdf", 1)],
  });
  assert.deepEqual(byId(report, "n").issues, ["LEGACY_UPLOADS_REFERENCE", "UPLOADS_ROOT_NOT_CONFIGURED"]);
  // Mirrors the submission routes: path.join(<storage>, "/uploads/y.pdf").
  assert.equal(byId(report, "s").resolvedRoot, "storage");
  assert.equal(byId(report, "s").resolvedRelativePath, "uploads/y.pdf");
  assert.ok(byId(report, "s").issues.includes("FILE_MISSING"));
});

test("invalid and traversal references are never inspected on disk", async (t) => {
  const f = await fixture(t);
  put(f.base, "secret.pdf", "outside the root");
  const roots = await FSI.openLegacyRoots({ storage: f.storage, publicUploads: f.uploads });
  const report = await INV.buildInventoryReport({
    roots,
    database: { databaseName: "slc_test" },
    notes: [
      note("n-traversal", "../secret.pdf", 16),
      note("n-deep-traversal", `lectures/${L1}/../../../secret.pdf`, 16),
      note("n-uploads-traversal", "/uploads/../../secret.pdf", 16),
      note("n-empty", "", 0),
      note("n-nul", "lectures/a\0b.pdf", 0),
      note("n-root", ".", 0),
      note("n-absolute", "/etc/passwd", 0),
      note("n-backslash", `lectures\\${L1}\\x.pdf`, 0),
    ],
    submissions: [submission("s-traversal", "../secret.pdf", 16)],
  });
  for (const id of ["n-traversal", "n-deep-traversal", "n-uploads-traversal", "n-root", "s-traversal"]) {
    const record = byId(report, id);
    assert.ok(record.issues.includes("UNSAFE_PATH"), id);
    assert.equal(record.resolvedPath, null, id);
    assert.equal(record.sha256, null, id);
  }
  assert.ok(byId(report, "n-empty").issues.includes("INVALID_REFERENCE"));
  assert.ok(byId(report, "n-nul").issues.includes("INVALID_REFERENCE"));
  // "/etc/passwd" stays inside the root exactly as the routes' path.join does, but is flagged.
  assert.deepEqual(byId(report, "n-absolute").unusualReference, ["ABSOLUTE", "UNEXPECTED_PREFIX"]);
  assert.ok(byId(report, "n-absolute").resolvedPath.startsWith(f.storage));
  assert.ok(byId(report, "n-backslash").unusualReference.includes("BACKSLASH"));
  assert.equal(report.summary.unsafeOrInvalidReferences, 7);
  assert.ok(!JSON.stringify(report).includes(sha("outside the root")), "the outside file was never hashed");
});

test("duplicate references: same path, a different spelling of it, and hard links; bytes are counted once", async (t) => {
  const f = await fixture(t);
  const original = put(f.storage, `lectures/${L1}/shared.pdf`, "0123456789");
  const linked = path.join(f.storage, "lectures", L2, "hardlink.pdf");
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  let hardLinks = true;
  try {
    fs.linkSync(original, linked);
  } catch {
    hardLinks = false;
  }
  const roots = await FSI.openLegacyRoots({ storage: f.storage });
  const notes = [
    note("n-a", `lectures/${L1}/shared.pdf`, 10),
    note("n-b", `lectures/${L1}/./shared.pdf`, 10),
    note("n-missing-1", `lectures/${L1}/same-missing.pdf`, 1),
    note("n-missing-2", `lectures/${L1}/same-missing.pdf`, 1),
  ];
  if (hardLinks) notes.push(note("n-c", `lectures/${L2}/hardlink.pdf`, 10, { lectureId: L2 }));
  const report = await INV.buildInventoryReport({ roots, database: { databaseName: "slc_test" }, notes, submissions: [] });

  const a = byId(report, "n-a");
  assert.ok(a.issues.includes("DUPLICATE_REFERENCE"));
  assert.ok(a.sharedWithRecords.some((r) => r.recordId === "n-b"));
  assert.ok(byId(report, "n-b").unusualReference.includes("DOT_SEGMENT"));
  assert.ok(byId(report, "n-missing-1").issues.includes("DUPLICATE_REFERENCE"), "the same missing path twice");
  if (hardLinks) assert.ok(a.sharedWithRecords.some((r) => r.recordId === "n-c"), "a hard link is the same physical file");
  else t.diagnostic("hard links not available here: the hard-link case was skipped");

  assert.equal(report.summary.duplicatePhysicalReferences.physicalFiles, 2);
  assert.equal(report.summary.bytesByResourceType.notes.bytes, 10, "the shared file counts once");
  assert.equal(report.bytesByTeacher.length, 1);
  assert.equal(report.bytesByTeacher[0].totalBytes, 10);
  assert.equal(report.summary.orphanFiles.count, 0, "a hard link of a referenced file is not an orphan");
});

test("orphan files and unexpected entries in storage/lectures and storage/assignments; other folders are not scanned", async (t) => {
  const f = await fixture(t);
  put(f.storage, `lectures/${L1}/referenced.pdf`, "r");
  put(f.storage, `lectures/${L1}/orphan.pdf`, "orphan!");
  put(f.storage, `assignments/${A1}/orphan-sub.pdf`, "o");
  put(f.storage, "lectures/stray-at-top.pdf", "s");
  put(f.storage, `lectures/${L1}/nested/deeper.pdf`, "d");
  put(f.storage, "class-papers/p/other-feature.pdf", "not ours");
  put(f.uploads, "teachers/avatar.jpg", "not ours");
  const roots = await FSI.openLegacyRoots({ storage: f.storage, publicUploads: f.uploads });
  const report = await INV.buildInventoryReport({
    roots,
    database: { databaseName: "slc_test" },
    notes: [note("n", `lectures/${L1}/referenced.pdf`, 1)],
    submissions: [],
  });
  assert.deepEqual(
    report.orphanFiles.map((o) => [o.relativePath, o.expectedLocation, o.sizeBytes]),
    [
      [`assignments/${A1}/orphan-sub.pdf`, true, 1],
      [`lectures/${L1}/nested/deeper.pdf`, false, 1],
      [`lectures/${L1}/orphan.pdf`, true, 7],
      ["lectures/stray-at-top.pdf", false, 1],
    ]
  );
  assert.equal(report.orphanFiles.find((o) => o.relativePath.endsWith("orphan.pdf")).sha256, sha("orphan!"));
  assert.equal(report.summary.orphanFiles.bytes, 10);
  assert.ok(!JSON.stringify(report.orphanFiles).includes("other-feature"));
  assert.ok(!JSON.stringify(report.orphanFiles).includes("avatar"));
  assert.deepEqual(report.scannedFolders, [
    { relativePath: "storage/lectures", scanned: true },
    { relativePath: "storage/assignments", scanned: true },
  ]);
});

test("symbolic links (directory junctions and file links) are reported and never followed", async (t) => {
  const f = await fixture(t);
  put(f.base, "outside/secret.pdf", "outside secret");
  fs.mkdirSync(path.join(f.storage, "lectures"), { recursive: true });
  try {
    fs.symlinkSync(path.join(f.base, "outside"), path.join(f.storage, "lectures", L2), "junction");
  } catch (error) {
    t.skip(`directory links unavailable: ${error.code}`);
    return;
  }
  let fileLink = true;
  put(f.storage, `lectures/${L1}/real.pdf`, "real");
  try {
    fs.symlinkSync(path.join(f.base, "outside", "secret.pdf"), path.join(f.storage, "lectures", L1, "link.pdf"), "file");
  } catch {
    fileLink = false;
  }
  const roots = await FSI.openLegacyRoots({ storage: f.storage });
  const notes = [note("n-through-dir-link", `lectures/${L2}/secret.pdf`, 14, { lectureId: L2 }), note("n-real", `lectures/${L1}/real.pdf`, 4)];
  if (fileLink) notes.push(note("n-file-link", `lectures/${L1}/link.pdf`, 14));
  const report = await INV.buildInventoryReport({ roots, database: { databaseName: "slc_test" }, notes, submissions: [] });

  assert.deepEqual(byId(report, "n-through-dir-link").issues, ["SYMLINK_IN_PATH"]);
  assert.equal(byId(report, "n-through-dir-link").sha256, null);
  if (fileLink) assert.deepEqual(byId(report, "n-file-link").issues, ["SYMLINK_IN_PATH"]);
  else t.diagnostic("file symlinks need extra privileges here: that case was skipped");
  assert.ok(report.unexpectedEntries.some((e) => e.relativePath === `lectures/${L2}` && e.kind === "symlink"));
  assert.ok(!JSON.stringify(report).includes(sha("outside secret")), "nothing behind a link was read");
  assert.equal(report.orphanFiles.length, 0, "the scan never enters the linked folder");

  // A root that is itself a link is refused.
  const linkedRoot = path.join(f.base, "linked-root");
  fs.symlinkSync(f.storage, linkedRoot, "junction");
  await assert.rejects(FSI.openLegacyRoots({ storage: linkedRoot }), { problem: "IS_A_LINK" });
  await assert.rejects(FSI.openLegacyRoots({ storage: path.join(linkedRoot, "lectures") }), { problem: "REACHED_THROUGH_A_LINK" });
});

test("soft-deleted notes count toward their teacher while their files exist; hidden parents are flagged; ownership conflicts count for nobody", async (t) => {
  const f = await fixture(t);
  put(f.storage, `lectures/${L1}/active.pdf`, "aaaa");
  put(f.storage, `lectures/${L1}/deleted.pdf`, "dddddd");
  put(f.storage, `lectures/${L2}/hidden.pdf`, "hh");
  put(f.storage, `assignments/${A1}/sub.pdf`, "sssss");
  put(f.storage, `lectures/${L1}/contested.pdf`, "cc");
  const roots = await FSI.openLegacyRoots({ storage: f.storage });
  const report = await INV.buildInventoryReport({
    roots,
    database: { databaseName: "slc_test" },
    notes: [
      note("n-active", `lectures/${L1}/active.pdf`, 4),
      note("n-deleted", `lectures/${L1}/deleted.pdf`, 6, { status: 1 }),
      note("n-deleted-missing", `lectures/${L1}/never-there.pdf`, 6, { status: 1 }),
      note("n-hidden", `lectures/${L2}/hidden.pdf`, 2, { lectureId: L2, lectureStatus: 1 }),
      note("n-contested-1", `lectures/${L1}/contested.pdf`, 2),
      note("n-contested-2", `lectures/${L1}/contested.pdf`, 2, { teacherId: T2 }),
    ],
    submissions: [submission("s", `assignments/${A1}/sub.pdf`, 5, { assignmentStatus: 1 })],
  });
  assert.equal(byId(report, "n-deleted").softDeleted, true);
  assert.equal(byId(report, "n-hidden").hiddenByParent, true);
  assert.equal(byId(report, "s").hiddenByParent, true);
  assert.deepEqual(report.summary.notes, { total: 6, active: 4, softDeleted: 2, hiddenByParent: 1 });
  assert.deepEqual(report.summary.softDeletedNotes, { records: 2, filesOnDisk: 1, bytesOnDisk: 6 });
  assert.deepEqual(report.bytesByTeacher, [
    { teacherId: T1, notesActiveBytes: 4 + 2, notesActiveFiles: 2, notesSoftDeletedBytes: 6, notesSoftDeletedFiles: 1, submissionsBytes: 5, submissionsFiles: 1, legacyBytes: 17, newStorageBytes: 0, totalBytes: 17 },
  ]);
  assert.equal(report.ownershipConflicts.length, 1);
  assert.deepEqual(report.ownershipConflicts[0].teacherIds, [T1, T2]);
});

test("the inventory never changes the inspected folders, creates nothing, and is repeatable", async (t) => {
  const f = await fixture(t);
  put(f.storage, `lectures/${L1}/a.pdf`, "aaaa");
  put(f.storage, `lectures/${L1}/orphan.pdf`, "o");
  put(f.uploads, "u.pdf", "u");
  // No assignments/ folder at all: it must not be created.
  const before = [snapshot(f.storage), snapshot(f.uploads)];
  const roots = await FSI.openLegacyRoots({ storage: f.storage, publicUploads: f.uploads });
  const input = { roots, database: { databaseName: "slc_test" }, notes: [note("n1", `lectures/${L1}/a.pdf`, 4), note("n2", "/uploads/u.pdf", 1)], submissions: [] };

  const first = await INV.buildInventoryReport({ ...input, now: () => new Date("2026-11-15T00:00:00Z") });
  const second = await INV.buildInventoryReport({ ...input, notes: [...input.notes].reverse(), now: () => new Date("2026-11-16T00:00:00Z") });

  assert.deepEqual([snapshot(f.storage), snapshot(f.uploads)], before);
  assert.equal(fs.existsSync(path.join(f.storage, "assignments")), false);
  assert.deepEqual(first.scannedFolders[1], { relativePath: "storage/assignments", scanned: false, reason: "MISSING" });
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.contentDigest, second.contentDigest, "same data, same digest (input order does not matter)");
  const { generatedAt: _a, ...restFirst } = first;
  const { generatedAt: _b, ...restSecond } = second;
  assert.deepEqual(restFirst, restSecond);

  put(f.storage, `lectures/${L1}/new.pdf`, "n");
  const third = await INV.buildInventoryReport(input);
  assert.notEqual(third.contentDigest, first.contentDigest, "a change on disk changes the digest");
});

test("roots must be existing, absolute, non-overlapping directories", async (t) => {
  const f = await fixture(t);
  await assert.rejects(FSI.openLegacyRoots({ storage: "relative/storage" }), { problem: "NOT_ABSOLUTE" });
  await assert.rejects(FSI.openLegacyRoots({ storage: path.join(f.base, "nope") }), { problem: "MISSING" });
  const file = put(f.base, "file.txt", "x");
  await assert.rejects(FSI.openLegacyRoots({ storage: file }), { problem: "NOT_A_DIRECTORY" });
  fs.mkdirSync(path.join(f.storage, "inner"));
  await assert.rejects(FSI.openLegacyRoots({ storage: f.storage, publicUploads: path.join(f.storage, "inner") }), { problem: "ROOTS_OVERLAP" });
});

// ---- Stage 2.1: storageKey / sha256, the new storage, rollback copies ---------------------------------------

const NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
const SK = require(path.join(root, "lib", "assignments", "submission-keys.ts"));
const N1 = "cccccccc-0000-4000-8000-000000000001";
const S1 = "dddddddd-0000-4000-8000-000000000001";

/** A fixture with the three roots: storage/, public-uploads/ and files/ (a copy of FILE_STORAGE_ROOT). */
async function fixture3(t) {
  const f = await fixture(t);
  const files = path.join(f.base, "files");
  fs.mkdirSync(files);
  return { ...f, files, roots: await FSI.openLegacyRoots({ storage: f.storage, publicUploads: f.uploads, fileStorage: files }) };
}

const noteKey = (noteId = N1, lectureId = L1, teacherId = T1, ext = ".pdf") =>
  NK.noteFileKey({ teacherId, lectureId, noteId, storedName: `${crypto.randomBytes(16).toString("hex")}${ext}` });
const subKey = (submissionId = S1) => SK.submissionFileKey({ teacherId: T1, lectureId: L1, assignmentId: A1, submissionId, storedName: SK.generateSubmissionStoredName() });

test("2.1: migrated (verified), rollback copy, new-storage-only and legacy records are told apart", async (t) => {
  const f = await fixture3(t);
  const bytes = "%PDF dual";
  // Dual-write note: new file + paired legacy copy.
  const dualKey = noteKey(N1);
  put(f.files, dualKey, bytes);
  const dualCopy = NK.noteLegacyCopyPath(dualKey);
  put(f.storage, dualCopy, bytes);
  // New-storage-only submission (dual-write off): fileUrl == storageKey.
  const onlyKey = subKey(S1);
  put(f.files, onlyKey, "%PDF sub");
  // Legacy note.
  put(f.storage, `lectures/${L1}/1700000000000-abc123-old.pdf`, "old");

  const report = await INV.buildInventoryReport({
    roots: f.roots,
    database: { databaseName: "slc_test" },
    notes: [
      note(N1, dualCopy, bytes.length, { storageKey: dualKey, sha256: sha(bytes) }),
      note("n-legacy", `lectures/${L1}/1700000000000-abc123-old.pdf`, 3),
    ],
    submissions: [submission(S1, onlyKey, 8, { storageKey: onlyKey, sha256: sha("%PDF sub") })],
  });
  const dual = byId(report, N1);
  assert.equal(dual.storageState, "MIGRATED");
  assert.equal(dual.legacyRole, "ROLLBACK_COPY");
  assert.deepEqual(dual.issues, []);
  assert.equal(dual.destination.hashMatches, true);
  assert.equal(dual.destination.sizeMatches, true);
  assert.equal(dual.sha256, sha(bytes), "the rollback copy was hashed too");
  const only = byId(report, S1);
  assert.equal(only.storageState, "MIGRATED");
  assert.equal(only.legacyRole, "NONE");
  assert.equal(only.resolvedPath, null, "no legacy file is expected or inspected");
  assert.deepEqual(only.issues, []);
  const legacy = byId(report, "n-legacy");
  assert.equal(legacy.storageState, "LEGACY");
  assert.equal(legacy.legacyRole, "PRIMARY");
  assert.equal(legacy.destination, null);

  const st = report.summary.storage;
  assert.deepEqual([st.legacyRecords, st.migratedRecords, st.migratedWithProblems], [1, 2, 0]);
  assert.deepEqual(st.rollbackCopies, { records: 1, missing: 0, hashMismatches: 0 });
  assert.deepEqual(report.summary.bytesByLocation, { legacy: { files: 2, bytes: bytes.length + 3 }, newStorage: { files: 2, bytes: bytes.length + 8 } });
  assert.equal(report.bytesByTeacher[0].newStorageBytes, bytes.length + 8);
  assert.equal(report.bytesByTeacher[0].legacyBytes, bytes.length + 3);
  assert.equal(report.summary.duplicatePhysicalReferences.physicalFiles, 0, "a record's two copies are not duplicates");
  assert.equal(st.unreferencedNewStorageFiles.count, 0);
  assert.equal(report.summary.orphanFiles.count, 0);
});

test("2.1: destination missing / size mismatch / hash mismatch / invalid key / owner mismatch / unrecorded hash", async (t) => {
  const f = await fixture3(t);
  const keys = { size: noteKey("n-size"), hash: noteKey("n-hash"), missing: noteKey("n-missing"), owner: noteKey("n-owner", L2), nohash: noteKey("n-nohash") };
  put(f.files, keys.size, "12345");
  put(f.files, keys.hash, "abc");
  put(f.files, keys.owner, "o");
  put(f.files, keys.nohash, "x");
  const report = await INV.buildInventoryReport({
    roots: f.roots,
    database: { databaseName: "slc_test" },
    notes: [
      note("n-size", keys.size, 99, { storageKey: keys.size, sha256: sha("12345") }),
      note("n-hash", keys.hash, 3, { storageKey: keys.hash, sha256: sha("different") }),
      note("n-missing", keys.missing, 1, { storageKey: keys.missing, sha256: sha("x") }),
      note("n-owner", keys.owner, 1, { storageKey: keys.owner, sha256: sha("o") }), // key says lecture L2, the row says L1
      note("n-invalid", "x", 1, { storageKey: "Teachers/../../etc/passwd", sha256: sha("x") }),
      note("n-subkey", "x", 1, { storageKey: subKey("n-subkey"), sha256: sha("x") }), // a submission key on a note
      note("n-nohash", keys.nohash, 1, { storageKey: keys.nohash, sha256: null }),
    ],
    submissions: [],
  });
  const issuesOf = (id) => byId(report, id).issues;
  assert.deepEqual(issuesOf("n-size"), ["DESTINATION_SIZE_MISMATCH"]);
  assert.deepEqual(issuesOf("n-hash"), ["DESTINATION_HASH_MISMATCH"]);
  assert.deepEqual(issuesOf("n-missing"), ["DESTINATION_MISSING"]);
  assert.deepEqual(issuesOf("n-owner"), ["DESTINATION_OWNER_MISMATCH"]);
  assert.ok(issuesOf("n-invalid").includes("INVALID_STORAGE_KEY"));
  assert.ok(issuesOf("n-subkey").includes("INVALID_STORAGE_KEY"));
  assert.deepEqual(issuesOf("n-nohash"), ["DESTINATION_HASH_UNRECORDED"]);
  for (const id of ["n-size", "n-hash", "n-missing", "n-owner", "n-invalid", "n-subkey", "n-nohash"]) {
    assert.equal(byId(report, id).storageState, "MIGRATED_WITH_PROBLEMS", id);
    assert.equal(byId(report, id).needsInvestigation, true, id);
  }
  assert.equal(byId(report, "n-invalid").destination, null, "an invalid key is never opened");
  const st = report.summary.storage;
  assert.deepEqual([st.destinationMissing, st.destinationSizeMismatches, st.destinationHashMismatches, st.invalidStorageKeys], [1, 1, 1, 2]);
});

test("2.1: rollback copies and retained originals must be present and identical", async (t) => {
  const f = await fixture3(t);
  const k1 = noteKey("n-copy-missing");
  const k2 = noteKey("n-copy-changed");
  const k3 = noteKey("n-retained");
  for (const k of [k1, k2, k3]) put(f.files, k, "SAME");
  put(f.storage, NK.noteLegacyCopyPath(k2), "DIFF");
  put(f.storage, `lectures/${L1}/1700000000000-abc123-orig.pdf`, "SAME");
  const report = await INV.buildInventoryReport({
    roots: f.roots,
    database: { databaseName: "slc_test" },
    notes: [
      note("n-copy-missing", NK.noteLegacyCopyPath(k1), 4, { storageKey: k1, sha256: sha("SAME") }),
      note("n-copy-changed", NK.noteLegacyCopyPath(k2), 4, { storageKey: k2, sha256: sha("SAME") }),
      note("n-retained", `lectures/${L1}/1700000000000-abc123-orig.pdf`, 4, { storageKey: k3, sha256: sha("SAME") }),
    ],
    submissions: [],
  });
  assert.equal(byId(report, "n-copy-missing").legacyRole, "ROLLBACK_COPY");
  assert.deepEqual(byId(report, "n-copy-missing").issues, ["LEGACY_COPY_MISSING"]);
  assert.deepEqual(byId(report, "n-copy-changed").issues, ["LEGACY_COPY_HASH_MISMATCH"]);
  assert.equal(byId(report, "n-retained").legacyRole, "RETAINED_ORIGINAL");
  assert.deepEqual(byId(report, "n-retained").issues, []);
  for (const id of ["n-copy-missing", "n-copy-changed", "n-retained"]) assert.equal(byId(report, id).storageState, "MIGRATED", "the destination itself is fine");
  assert.deepEqual(report.summary.storage.rollbackCopies, { records: 2, missing: 1, hashMismatches: 1 });
  assert.deepEqual(report.summary.storage.retainedOriginals, { records: 1, missing: 0, hashMismatches: 0 });
});

test("2.1: unreferenced new-storage files are reported; Recorded Lectures and System folders are never scanned; links never followed", async (t) => {
  const f = await fixture3(t);
  const referenced = noteKey("n-ref");
  put(f.files, referenced, "r");
  const stray = noteKey("n-gone");
  put(f.files, stray, "stray!");
  const straySub = subKey("s-gone");
  put(f.files, straySub, "sub");
  put(f.files, `Teachers/${T1}/Lectures/${L1}/Notes/odd.pdf`, "odd");
  put(f.files, `Teachers/${T1}/Lectures/${L1}/RecordedLectures/${crypto.randomUUID()}/${"e".repeat(32)}.mp4`, "video");
  put(f.files, "System/TemporaryUploads/x.part", "tmp");
  put(f.base, "outside/secret.pdf", "SECRET");
  let linked = true;
  try {
    fs.symlinkSync(path.join(f.base, "outside"), path.join(f.files, "Teachers", T1, "Lectures", L1, "Notes", "linked"), "junction");
  } catch {
    linked = false;
  }
  const before = snapshot(f.files);
  const report = await INV.buildInventoryReport({ roots: f.roots, database: { databaseName: "slc_test" }, notes: [note("n-ref", referenced, 1, { storageKey: referenced, sha256: sha("r") })], submissions: [] });
  assert.deepEqual(
    report.unreferencedNewStorageFiles.map((o) => [o.relativePath, o.expectedLocation, o.sizeBytes]),
    [
      [straySub, true, 3],
      [`Teachers/${T1}/Lectures/${L1}/Notes/odd.pdf`, false, 3],
      [stray, true, 6],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  );
  assert.equal(report.unreferencedNewStorageFiles.find((o) => o.relativePath === stray).sha256, sha("stray!"));
  assert.deepEqual(report.summary.storage.unreferencedNewStorageFiles, { count: 3, bytes: 12 });
  assert.ok(!JSON.stringify(report.unreferencedNewStorageFiles).includes("RecordedLectures"));
  assert.ok(!JSON.stringify(report.unreferencedNewStorageFiles).includes("System"));
  assert.ok(report.scannedFolders.some((s) => s.relativePath.endsWith("RecordedLectures") && s.reason === "OTHER_FEATURE"));
  if (linked) {
    assert.ok(report.unexpectedEntries.some((e) => e.root === "fileStorage" && e.kind === "symlink"));
    assert.ok(!JSON.stringify(report).includes(sha("SECRET")), "nothing behind the link was read");
  } else t.diagnostic("links unavailable here: the link case was skipped");
  assert.deepEqual(snapshot(f.files), before, "the new storage is unchanged");
});

test("2.1: a physical file shared between a legacy reference and another record's destination is a duplicate", async (t) => {
  const f = await fixture3(t);
  const key = noteKey("n-new");
  const stored = put(f.files, key, "SHARED");
  const legacyPath = path.join(f.storage, "lectures", L1, "1700000000000-abc123-x.pdf");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  try {
    fs.linkSync(stored, legacyPath);
  } catch (error) {
    t.skip(`hard links across these folders are unavailable: ${error.code}`);
    return;
  }
  const report = await INV.buildInventoryReport({
    roots: f.roots,
    database: { databaseName: "slc_test" },
    notes: [note("n-new", key, 6, { storageKey: key, sha256: sha("SHARED") }), note("n-old", `lectures/${L1}/1700000000000-abc123-x.pdf`, 6)],
    submissions: [],
  });
  assert.ok(byId(report, "n-new").issues.includes("DUPLICATE_REFERENCE"));
  assert.deepEqual(byId(report, "n-old").sharedWithRecords, [{ resourceType: "NOTE", recordId: "n-new" }]);
  assert.equal(report.summary.bytesByResourceType.distinctTotal.files, 1, "counted once");
});

test("2.1: stored records without --file-storage-root are flagged, never guessed; roots may not overlap", async (t) => {
  const f = await fixture(t);
  const roots = await FSI.openLegacyRoots({ storage: f.storage });
  const key = noteKey();
  const report = await INV.buildInventoryReport({ roots, database: { databaseName: "slc_test" }, notes: [note(N1, key, 1, { storageKey: key, sha256: sha("x") })], submissions: [] });
  assert.deepEqual(byId(report, N1).issues, ["NEW_STORAGE_ROOT_NOT_CONFIGURED"]);
  assert.equal(byId(report, N1).storageState, "MIGRATED_WITH_PROBLEMS");
  assert.ok(report.notScanned.some((s) => /no --file-storage-root/.test(s)));
  fs.mkdirSync(path.join(f.storage, "inner"));
  await assert.rejects(FSI.openLegacyRoots({ storage: f.storage, fileStorage: path.join(f.storage, "inner") }), { problem: "ROOTS_OVERLAP" });
  await assert.rejects(FSI.openLegacyRoots({ storage: path.join(f.storage, "inner"), fileStorage: f.storage }), { problem: "ROOTS_OVERLAP" });
});

test("2.1: the inventory is still read-only and repeatable with all three roots", async (t) => {
  const f = await fixture3(t);
  const key = noteKey();
  put(f.files, key, "x");
  put(f.storage, NK.noteLegacyCopyPath(key), "x");
  put(f.files, noteKey("n-stray"), "y");
  const before = [snapshot(f.storage), snapshot(f.uploads), snapshot(f.files)];
  const input = { roots: f.roots, database: { databaseName: "slc_test" }, notes: [note(N1, NK.noteLegacyCopyPath(key), 1, { storageKey: key, sha256: sha("x") })], submissions: [] };
  const a = await INV.buildInventoryReport({ ...input, now: () => new Date(1) });
  const b = await INV.buildInventoryReport({ ...input, now: () => new Date(2) });
  assert.equal(a.contentDigest, b.contentDigest);
  assert.deepEqual([snapshot(f.storage), snapshot(f.uploads), snapshot(f.files)], before);
});

test("2.1: the database read includes storageKey and sha256 (still findMany only, read-only transaction)", async () => {
  assert.equal(DB.NOTE_SELECT.storageKey, true);
  assert.equal(DB.NOTE_SELECT.sha256, true);
  assert.equal(DB.SUBMISSION_SELECT.storageKey, true);
  assert.equal(DB.SUBMISSION_SELECT.sha256, true);
});

// ---- CLI -------------------------------------------------------------------------------------------------

function cliHarness(rows = {}) {
  const logs = [];
  const errors = [];
  const state = { constructed: 0, options: null, disconnected: false };
  const db = fakeDatabase(rows);
  const env = { STORAGE_INVENTORY_DATABASE_URL: "postgresql://inv:s3cretPassw0rd@127.0.0.1:5432/slc_inventory_test" };
  class FakePrismaClient {
    constructor(options) {
      state.constructed++;
      state.options = options;
      env.DATABASE_URL = "postgresql://neon-from-dotenv/neondb";
    }
    $transaction(fn, options) {
      return db.client.$transaction(fn, options);
    }
    async $disconnect() {
      state.disconnected = true;
    }
  }
  const deps = {
    env,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    loadPrismaClient: async () => FakePrismaClient,
    now: () => new Date("2026-11-15T00:00:00Z"),
  };
  return { deps, logs, errors, state, env, db };
}

test("CLI: usage errors exit 2 without touching the database", async () => {
  const cases = [[], ["--storage-root=/x"], ["--storage-root=/x", "--out=relative.json", "--confirm-database=a_test"], ["--storage-root=/x", "--out=/r.txt", "--confirm-database=a_test"], ["--bogus=1"], ["--storage-root=/a", "--storage-root=/b"]];
  for (const argv of cases) {
    const h = cliHarness();
    assert.equal(await CLI.runStorageInventoryCli(argv, h.deps), 2, argv.join(" "));
    assert.equal(h.state.constructed, 0);
  }
});

test("CLI: refuses before loading Prisma — missing URL, remote URL, wrong confirmation, unsafe report path", async (t) => {
  const f = await fixture(t);
  const out = path.join(f.base, "report.json");
  const args = [`--storage-root=${f.storage}`, `--out=${out}`, "--confirm-database=slc_inventory_test"];

  const missing = cliHarness();
  delete missing.env.STORAGE_INVENTORY_DATABASE_URL;
  missing.env.DATABASE_URL = "postgresql://u:p@127.0.0.1/slc_inventory_test"; // never used as a fallback
  assert.equal(await CLI.runStorageInventoryCli(args, missing.deps), 1);
  assert.match(missing.errors[0], /STORAGE_INVENTORY_DATABASE_URL is not set/);

  const remote = cliHarness();
  remote.env.STORAGE_INVENTORY_DATABASE_URL = "postgresql://u:topsecret@ep-x-pooler.neon.tech/slc_inventory_test";
  assert.equal(await CLI.runStorageInventoryCli(args, remote.deps), 1);
  assert.match(remote.errors.join("\n"), /must be localhost/);
  assert.doesNotMatch(remote.errors.join("\n"), /topsecret|neon\.tech/);

  const wrongName = cliHarness();
  assert.equal(await CLI.runStorageInventoryCli([...args.slice(0, 2), "--confirm-database=other_test"], wrongName.deps), 1);

  const insideRoot = cliHarness();
  assert.equal(await CLI.runStorageInventoryCli([args[0], `--out=${path.join(f.storage, "r.json")}`, args[2]], insideRoot.deps), 1);
  assert.match(insideRoot.errors[0], /outside the inspected roots/);

  const noFolder = cliHarness();
  assert.equal(await CLI.runStorageInventoryCli([args[0], `--out=${path.join(f.base, "missing-dir", "r.json")}`, args[2]], noFolder.deps), 1);
  assert.equal(fs.existsSync(path.join(f.base, "missing-dir")), false);

  for (const h of [missing, remote, wrongName, insideRoot, noFolder]) assert.equal(h.state.constructed, 0);
  assert.deepEqual(fs.readdirSync(f.base).sort(), ["outside", "public-uploads", "storage"], "no report written");
});

test("CLI: writes the JSON and summary once (never overwrites), strips .env variables, prints no ids, paths or credentials", async (t) => {
  const f = await fixture(t);
  put(f.storage, `lectures/${L1}/a.pdf`, "aaaa");
  const out = path.join(f.base, "report.json");
  const args = [`--storage-root=${f.storage}`, `--public-uploads-root=${f.uploads}`, `--out=${out}`, "--confirm-database=slc_inventory_test"];
  const h = cliHarness({ notes: [note("note-id-visible-only-in-json", `lectures/${L1}/a.pdf`, 4)] });

  assert.equal(await CLI.runStorageInventoryCli(args, h.deps), 0, h.errors.join("\n"));
  assert.equal(h.state.constructed, 1);
  assert.equal(h.state.options.datasources.db.url, h.env.STORAGE_INVENTORY_DATABASE_URL);
  assert.equal(h.env.DATABASE_URL, undefined, "the variable Prisma's .env loading added was removed");
  assert.equal(h.state.disconnected, true);

  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(report.summary.existingFiles, 1);
  assert.deepEqual(report.database, { host: "loopback", databaseName: "slc_inventory_test" });
  assert.doesNotMatch(fs.readFileSync(out, "utf8"), /s3cretPassw0rd|inv:/);
  const summary = fs.readFileSync(out.replace(/\.json$/, ".summary.txt"), "utf8");
  assert.match(summary, new RegExp(T1));

  const consoleText = [...h.logs, ...h.errors].join("\n");
  assert.doesNotMatch(consoleText, /s3cretPassw0rd|note-id-visible-only-in-json|11111111-|a\.pdf/);
  assert.match(consoleText, /Missing legacy files:\s+0/);
  assert.match(consoleText, /no --file-storage-root given/, "says the new storage was not verified");

  const again = cliHarness();
  assert.equal(await CLI.runStorageInventoryCli(args, again.deps), 1);
  assert.match(again.errors[0], /never overwritten/);
});

test("CLI 2.1: --file-storage-root is inspected; a report inside it is refused before the database is touched", async (t) => {
  const f = await fixture(t);
  const files = path.join(f.base, "files");
  fs.mkdirSync(files);
  const key = noteKey();
  put(files, key, "abc");
  const refused = cliHarness();
  const args = (out) => [`--storage-root=${f.storage}`, `--file-storage-root=${files}`, `--out=${out}`, "--confirm-database=slc_inventory_test"];
  assert.equal(await CLI.runStorageInventoryCli(args(path.join(files, "r.json")), refused.deps), 1);
  assert.match(refused.errors[0], /outside the inspected roots/);
  assert.equal(refused.state.constructed, 0);

  const ok = cliHarness({ notes: [note(N1, key, 3, { storageKey: key, sha256: sha("abc") })] });
  const out = path.join(f.base, "r.json");
  assert.equal(await CLI.runStorageInventoryCli(args(out), ok.deps), 0, ok.errors.join("\n"));
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(report.summary.storage.migratedRecords, 1);
  assert.equal(report.roots.fileStorage, files);
  assert.match(ok.logs.join("\n"), /Migrated records:\s+1 verified/);
});

test("CLI: a database failure is reported by code only and writes nothing", async (t) => {
  const f = await fixture(t);
  const out = path.join(f.base, "report.json");
  const h = cliHarness();
  h.deps.loadPrismaClient = async () =>
    class {
      $transaction() {
        const error = new Error("Can't reach database server at `127.0.0.1:5432` with password s3cretPassw0rd");
        error.name = "PrismaClientInitializationError";
        error.code = "P1001";
        throw error;
      }
      async $disconnect() {}
    };
  assert.equal(await CLI.runStorageInventoryCli([`--storage-root=${f.storage}`, `--out=${out}`, "--confirm-database=slc_inventory_test"], h.deps), 1);
  assert.match(h.errors.join("\n"), /PrismaClientInitializationError P1001/);
  assert.doesNotMatch(h.errors.join("\n"), /s3cret|127\.0\.0\.1/);
  assert.equal(fs.existsSync(out), false);
});

// ---- Source guards ------------------------------------------------------------------------------------------

test("source: no lib/prisma, no filesystem writes in the library, no data-changing database calls", () => {
  // Code only: comments may legitimately mention "link (", DATABASE_URL, etc.
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const lib = ["inventory-database.ts", "inventory-filesystem.ts", "inventory.ts"].map((name) => read("lib", "storage-migration", name));
  const cli = read("scripts", "storage-inventory-cli.ts");
  const entry = read("scripts", "storage-inventory.ts");
  for (const src of [...lib, cli, entry]) {
    assert.doesNotMatch(src, /@\/lib\/prisma|from "\.\.?\/.*prisma"/);
    assert.doesNotMatch(src, /env\.DATABASE_URL|\["DATABASE_URL"\]/, "DATABASE_URL is never read");
    // (hash.update / createHash(...).update are SHA-256, not database calls.)
    assert.doesNotMatch(src, /(?<!hash|\))\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw`|\$queryRaw`/);
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\s+(INTO|TABLE|FROM|INDEX|\w+\s+SET)/);
  }
  for (const src of lib) {
    assert.doesNotMatch(src, /\b(writeFile|appendFile|mkdir|rename|unlink|rmdir|rm|copyFile|cp|truncate|symlink|link|chmod|chown|utimes|createWriteStream)\b\s*\(/);
    assert.doesNotMatch(src, /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND|["']w\+?["']|["']a\+?["']/);
  }
  // The only raw statements: the read-only transaction and two SHOWs.
  const rawCalls = lib[0].match(/\$(executeRawUnsafe|queryRawUnsafe)\((\w+)\)/g);
  assert.deepEqual(rawCalls, ["$executeRawUnsafe(READ_ONLY_TRANSACTION_SQL)", "$queryRawUnsafe(SHOW_READ_ONLY_SQL)", "$queryRawUnsafe(SHOW_ISOLATION_SQL)"]);
  // The CLI writes exactly the two report files, exclusively.
  const writes = cli.split("\n").filter((line) => /\bwriteFile\(/.test(line));
  assert.equal(writes.length, 2);
  for (const line of writes) assert.match(line, /\{ flag: "wx" \}\);$/);
  assert.doesNotMatch(cli, /\b(mkdir|rename|unlink|rm|copyFile)\s*\(/);
});
