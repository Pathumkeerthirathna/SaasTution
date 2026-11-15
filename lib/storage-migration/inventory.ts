import { createHash } from "node:crypto";

import { parseSubmissionStorageKey, submissionLegacyCopyPath } from "@/lib/assignments/submission-keys";
import { noteLegacyCopyPath, parseNoteStorageKey } from "@/lib/notes/storage-keys";

import type { InventoryNoteRow, InventorySubmissionRow } from "./inventory-database";
import {
  inspectFile,
  isStorageKeyOfKind,
  normaliseForCompare,
  resolveLegacyReference,
  scanLegacyFolders,
  scanNewStorage,
  type FileProblem,
  type LegacyRootName,
  type LegacyRoots,
  type ResolutionProblem,
  type ScannedFile,
  type UnexpectedEntry,
} from "./inventory-filesystem";

/*
 * Unified storage migration: the inventory report (Stage 1 baseline,
 * extended in Stage 2.1 for storageKey / sha256). Pure aggregation over the
 * database rows and the read-only filesystem inspection; nothing is written.
 *
 * Every record is classified:
 *   LEGACY                  storageKey null: the file is read from fileUrl (legacy location).
 *   MIGRATED                storageKey set and the new-storage file exists with the
 *                           database size and SHA-256.
 *   MIGRATED_WITH_PROBLEMS  storageKey set but invalid, missing, unreadable, of another
 *                           size or hash, or not under the record's own teacher / lecture.
 * and, for a record with a storageKey, its legacy file's role:
 *   NONE               fileUrl == storageKey (no legacy file exists or is expected);
 *   ROLLBACK_COPY      fileUrl is the copy paired with the key (dual-write window);
 *   RETAINED_ORIGINAL  any other fileUrl (an original kept after a copy into new storage).
 * A legacy copy / original must still be present and identical (SHA-256) while it
 * is kept; that is checked too.
 *
 * Ownership: Note -> Lecture -> Class.teacherId; AssignmentSubmission ->
 * Assignment -> Lecture -> Class.teacherId. Bytes are counted once per
 * PHYSICAL file (device + inode) over both locations, so nothing is
 * double-counted; a file referenced by records of different teachers is
 * counted for nobody and listed as a conflict.
 *
 * Repeatable: records, orphans and entries are sorted; contentDigest is the
 * SHA-256 of the report without generatedAt / contentDigest.
 */

export const INVENTORY_REPORT_VERSION = 2;

export type ResourceType = "NOTE" | "ASSIGNMENT_SUBMISSION";
export type StorageState = "LEGACY" | "MIGRATED" | "MIGRATED_WITH_PROBLEMS";
export type LegacyRole = "PRIMARY" | "ROLLBACK_COPY" | "RETAINED_ORIGINAL" | "NONE";

export type RecordIssue =
  | ResolutionProblem
  | FileProblem
  | "SIZE_MISMATCH"
  | "DUPLICATE_REFERENCE"
  | "UNUSUAL_REFERENCE"
  | "FOLDER_MISMATCH"
  | "OWNERSHIP_UNKNOWN"
  | "LEGACY_UPLOADS_REFERENCE"
  // Stage 2.1: the new storage and the legacy copy / original of a stored record.
  | "INVALID_STORAGE_KEY"
  | "NEW_STORAGE_ROOT_NOT_CONFIGURED"
  | "DESTINATION_MISSING"
  | "DESTINATION_UNREADABLE"
  | "DESTINATION_SIZE_MISMATCH"
  | "DESTINATION_HASH_MISMATCH"
  | "DESTINATION_HASH_UNRECORDED"
  | "DESTINATION_OWNER_MISMATCH"
  | "LEGACY_COPY_MISSING"
  | "LEGACY_COPY_HASH_MISMATCH";

/** Informational only; everything else needs a person to look at the record before migration. */
const INFORMATIONAL: ReadonlySet<RecordIssue> = new Set<RecordIssue>(["LEGACY_UPLOADS_REFERENCE"]);

export type DestinationInspection = {
  relativePath: string;
  fileExists: boolean;
  problem: FileProblem | null;
  actualSizeBytes: number | null;
  sha256: string | null;
  sizeMatches: boolean | null;
  hashMatches: boolean | null;
  physicalFileId: string | null;
};

export type InventoryRecord = {
  resourceType: ResourceType;
  recordId: string;
  teacherId: string | null;
  classId: string | null;
  lectureId: string | null;
  assignmentId: string | null;
  /** status columns as stored (0 = active); null where the model has none. */
  recordStatus: number | null;
  assignmentStatus: number | null;
  lectureStatus: number | null;
  classStatus: number | null;
  /** The record itself is soft-deleted (Note.status != 0). Submissions have no status column. */
  softDeleted: boolean;
  /** A parent (assignment, lecture or class) is soft-deleted, so the app hides the record. */
  hiddenByParent: boolean;
  mimeType: string;
  databaseSizeBytes: number;
  storageState: StorageState;
  legacyRole: LegacyRole;
  /** Unified storage: the stored key and digest (null for a legacy record). */
  storageKey: string | null;
  databaseSha256: string | null;
  destination: DestinationInspection | null;
  // The LEGACY file (fileUrl); not inspected when legacyRole is NONE.
  databaseFileReference: string;
  legacyUploadsReference: boolean;
  resolvedRoot: LegacyRootName | null;
  resolvedRelativePath: string | null;
  resolvedPath: string | null;
  unusualReference: string[];
  fileExists: boolean;
  actualSizeBytes: number | null;
  sizeMatches: boolean | null;
  sha256: string | null;
  physicalFileId: string | null;
  /** Other records that reference one of this record's physical files (or the same missing legacy path). */
  sharedWithRecords: Array<{ resourceType: ResourceType; recordId: string }>;
  issues: RecordIssue[];
  needsInvestigation: boolean;
};

export type OrphanFile = { root: LegacyRootName; relativePath: string; sizeBytes: number | null; sha256: string | null; expectedLocation: boolean; problem: FileProblem | null };

export type TeacherUsage = {
  teacherId: string;
  notesActiveBytes: number;
  notesActiveFiles: number;
  notesSoftDeletedBytes: number;
  notesSoftDeletedFiles: number;
  submissionsBytes: number;
  submissionsFiles: number;
  /** Of totalBytes: in the legacy storage / in the new storage. */
  legacyBytes: number;
  newStorageBytes: number;
  totalBytes: number;
};

type FilesAndBytes = { files: number; bytes: number };

export type InventorySummary = {
  notes: { total: number; active: number; softDeleted: number; hiddenByParent: number };
  submissions: { total: number; hiddenByParent: number };
  storage: {
    legacyRecords: number;
    migratedRecords: number;
    migratedWithProblems: number;
    destinationMissing: number;
    destinationSizeMismatches: number;
    destinationHashMismatches: number;
    invalidStorageKeys: number;
    rollbackCopies: { records: number; missing: number; hashMismatches: number };
    retainedOriginals: { records: number; missing: number; hashMismatches: number };
    unreferencedNewStorageFiles: { count: number; bytes: number };
  };
  /** Records whose LEGACY file exists / is missing (records that have one). */
  existingFiles: number;
  missingFiles: number;
  sizeMismatches: number;
  duplicatePhysicalReferences: { physicalFiles: number; records: number };
  orphanFiles: { count: number; bytes: number };
  legacyUploadsReferences: number;
  unsafeOrInvalidReferences: number;
  symlinksEncountered: number;
  unexpectedEntries: number;
  bytesByResourceType: { notes: FilesAndBytes; submissions: FilesAndBytes; distinctTotal: FilesAndBytes };
  bytesByLocation: { legacy: FilesAndBytes; newStorage: FilesAndBytes };
  softDeletedNotes: { records: number; filesOnDisk: number; bytesOnDisk: number };
  teachers: number;
  ownershipConflicts: number;
  recordsNeedingInvestigation: number;
  scanTruncated: boolean;
};

export type InventoryReport = {
  reportVersion: number;
  generatedAt: string;
  contentDigest: string;
  database: { host: "loopback"; databaseName: string };
  roots: { storage: string; publicUploads: string | null; fileStorage: string | null };
  scannedFolders: Array<{ relativePath: string; scanned: boolean; reason?: string }>;
  notScanned: string[];
  summary: InventorySummary;
  bytesByTeacher: TeacherUsage[];
  ownershipConflicts: Array<{ physicalFileId: string; teacherIds: string[]; records: Array<{ resourceType: ResourceType; recordId: string }> }>;
  records: InventoryRecord[];
  orphanFiles: OrphanFile[];
  unreferencedNewStorageFiles: OrphanFile[];
  unexpectedEntries: UnexpectedEntry[];
  manualInvestigation: Array<{ resourceType: ResourceType; recordId: string; issues: RecordIssue[] }>;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function baseRecord(input: {
  resourceType: ResourceType;
  recordId: string;
  fileUrl: string;
  storageKey: string | null | undefined;
  sha256: string | null | undefined;
  mimeType: string;
  sizeBytes: number;
  recordStatus: number | null;
  assignmentId: string | null;
  assignmentStatus: number | null;
  lecture: InventoryNoteRow["lecture"];
  lectureId: string | null;
}): InventoryRecord {
  const lecture = input.lecture;
  const teacherId = lecture?.class?.teacherId ?? null;
  const softDeleted = input.recordStatus !== null && input.recordStatus !== 0;
  const hiddenByParent =
    (input.assignmentStatus !== null && input.assignmentStatus !== 0) ||
    (lecture !== null && lecture.status !== 0) ||
    (lecture?.class ? lecture.class.status !== 0 : false);
  const storageKey = input.storageKey ?? null;
  return {
    resourceType: input.resourceType,
    recordId: input.recordId,
    teacherId,
    classId: lecture?.classId ?? null,
    lectureId: input.lectureId,
    assignmentId: input.assignmentId,
    recordStatus: input.recordStatus,
    assignmentStatus: input.assignmentStatus,
    lectureStatus: lecture?.status ?? null,
    classStatus: lecture?.class?.status ?? null,
    softDeleted,
    hiddenByParent,
    mimeType: input.mimeType,
    databaseSizeBytes: input.sizeBytes,
    storageState: storageKey ? "MIGRATED_WITH_PROBLEMS" : "LEGACY",
    legacyRole: "PRIMARY",
    storageKey,
    databaseSha256: input.sha256 ?? null,
    destination: null,
    databaseFileReference: input.fileUrl,
    legacyUploadsReference: input.fileUrl.startsWith("/uploads/"),
    resolvedRoot: null,
    resolvedRelativePath: null,
    resolvedPath: null,
    unusualReference: [],
    fileExists: false,
    actualSizeBytes: null,
    sizeMatches: null,
    sha256: null,
    physicalFileId: null,
    sharedWithRecords: [],
    issues: teacherId ? [] : ["OWNERSHIP_UNKNOWN"],
    needsInvestigation: false,
  };
}

export function recordsFromRows(notes: InventoryNoteRow[], submissions: InventorySubmissionRow[]): InventoryRecord[] {
  const records: InventoryRecord[] = [];
  for (const note of notes) {
    records.push(
      baseRecord({
        resourceType: "NOTE",
        recordId: note.id,
        fileUrl: note.fileUrl,
        storageKey: note.storageKey,
        sha256: note.sha256,
        mimeType: note.mimeType,
        sizeBytes: note.sizeBytes,
        recordStatus: note.status,
        assignmentId: null,
        assignmentStatus: null,
        lecture: note.lecture,
        lectureId: note.lectureId,
      })
    );
  }
  for (const submission of submissions) {
    records.push(
      baseRecord({
        resourceType: "ASSIGNMENT_SUBMISSION",
        recordId: submission.id,
        fileUrl: submission.fileUrl,
        storageKey: submission.storageKey,
        sha256: submission.sha256,
        mimeType: submission.mimeType,
        sizeBytes: submission.sizeBytes,
        recordStatus: null,
        assignmentId: submission.assignmentId,
        assignmentStatus: submission.assignment?.status ?? null,
        lecture: submission.assignment?.lecture ?? null,
        lectureId: submission.assignment?.lectureId ?? null,
      })
    );
  }
  return records.sort((a, b) => compare(a.resourceType, b.resourceType) || compare(a.recordId, b.recordId));
}

/** The id the record's legacy folder should carry: lectures/{lectureId}/... or assignments/{assignmentId}/... */
function folderMismatch(record: InventoryRecord, relativePath: string): boolean {
  const [folder, id] = relativePath.split("/");
  if (record.resourceType === "NOTE" && folder === "lectures") return id !== record.lectureId;
  if (record.resourceType === "ASSIGNMENT_SUBMISSION" && folder === "assignments") return id !== record.assignmentId;
  return false;
}

/** The key must sit under the record's own teacher, lecture (assignment) and record id. */
function keyOwnerMismatch(record: InventoryRecord): boolean {
  if (!record.storageKey) return false;
  if (record.resourceType === "NOTE") {
    const k = parseNoteStorageKey(record.storageKey);
    return !k || k.teacherId !== record.teacherId || k.lectureId !== record.lectureId || k.noteId !== record.recordId;
  }
  const k = parseSubmissionStorageKey(record.storageKey);
  return !k || k.teacherId !== record.teacherId || k.lectureId !== record.lectureId || k.assignmentId !== record.assignmentId || k.submissionId !== record.recordId;
}

function pairedLegacyCopy(record: InventoryRecord): string | null {
  if (!record.storageKey) return null;
  try {
    return record.resourceType === "NOTE" ? noteLegacyCopyPath(record.storageKey) : submissionLegacyCopyPath(record.storageKey);
  } catch {
    return null;
  }
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function inspectDestination(record: InventoryRecord, roots: LegacyRoots) {
  const key = record.storageKey as string;
  if (!isStorageKeyOfKind(record.resourceType, key)) {
    record.issues.push("INVALID_STORAGE_KEY");
    return;
  }
  if (keyOwnerMismatch(record)) record.issues.push("DESTINATION_OWNER_MISMATCH");
  if (!roots.fileStorage) {
    record.issues.push("NEW_STORAGE_ROOT_NOT_CONFIGURED");
    return;
  }
  const inspection = await inspectFile(roots.fileStorage, key);
  const destination: DestinationInspection = {
    relativePath: key,
    fileExists: inspection.exists,
    problem: inspection.exists ? null : inspection.problem,
    actualSizeBytes: inspection.exists ? inspection.sizeBytes : null,
    sha256: inspection.exists ? inspection.sha256 : null,
    sizeMatches: inspection.exists ? inspection.sizeBytes === record.databaseSizeBytes : null,
    hashMatches: inspection.exists && record.databaseSha256 ? inspection.sha256 === record.databaseSha256 : null,
    physicalFileId: inspection.exists ? inspection.physicalId : null,
  };
  record.destination = destination;
  if (!inspection.exists) {
    record.issues.push(inspection.problem === "FILE_MISSING" ? "DESTINATION_MISSING" : "DESTINATION_UNREADABLE");
    return;
  }
  if (!destination.sizeMatches) record.issues.push("DESTINATION_SIZE_MISMATCH");
  if (!record.databaseSha256) record.issues.push("DESTINATION_HASH_UNRECORDED");
  else if (!destination.hashMatches) record.issues.push("DESTINATION_HASH_MISMATCH");
  const problems = record.issues.filter((issue) => issue.startsWith("DESTINATION_") || issue === "INVALID_STORAGE_KEY");
  if (problems.length === 0) record.storageState = "MIGRATED";
}

async function inspectLegacy(record: InventoryRecord, roots: LegacyRoots) {
  const resolved = resolveLegacyReference(record.resourceType, record.databaseFileReference, roots);
  if (record.legacyUploadsReference) record.issues.push("LEGACY_UPLOADS_REFERENCE");
  if (!resolved.ok) {
    record.issues.push(resolved.problem);
    return;
  }
  record.resolvedRoot = resolved.root;
  record.resolvedRelativePath = resolved.relativePath;
  record.resolvedPath = resolved.absolutePath;
  record.unusualReference = resolved.unusual;
  if (resolved.unusual.length > 0) record.issues.push("UNUSUAL_REFERENCE");
  if (folderMismatch(record, resolved.relativePath)) record.issues.push("FOLDER_MISMATCH");

  const rootPath = resolved.root === "storage" ? roots.storage : (roots.publicUploads as string);
  const inspection = await inspectFile(rootPath, resolved.relativePath);
  const isPrimary = record.legacyRole === "PRIMARY";
  if (inspection.exists) {
    record.fileExists = true;
    record.actualSizeBytes = inspection.sizeBytes;
    record.sha256 = inspection.sha256;
    record.physicalFileId = inspection.physicalId;
    record.sizeMatches = inspection.sizeBytes === record.databaseSizeBytes;
    if (isPrimary && !record.sizeMatches) record.issues.push("SIZE_MISMATCH");
    // A copy / original kept beside the stored file must be identical to it.
    if (!isPrimary && record.databaseSha256 && inspection.sha256 !== record.databaseSha256) record.issues.push("LEGACY_COPY_HASH_MISMATCH");
  } else if (!isPrimary && inspection.problem === "FILE_MISSING") {
    record.issues.push("LEGACY_COPY_MISSING");
  } else {
    record.issues.push(inspection.problem);
  }
}

type Reference = { record: InventoryRecord; location: "legacy" | "newStorage"; physicalId: string; sizeBytes: number };

export async function buildInventoryReport(input: {
  notes: InventoryNoteRow[];
  submissions: InventorySubmissionRow[];
  roots: LegacyRoots;
  database: { databaseName: string };
  now?: () => Date;
  maxScanEntries?: number;
}): Promise<InventoryReport> {
  const { roots } = input;
  const records = recordsFromRows(input.notes, input.submissions);

  // 1. Each record's files: the new-storage destination (if any), then the legacy file (unless none is expected).
  for (const record of records) {
    if (record.storageKey) {
      await inspectDestination(record, roots);
      const paired = pairedLegacyCopy(record);
      record.legacyRole =
        record.databaseFileReference === record.storageKey ? "NONE" : paired !== null && record.databaseFileReference === paired ? "ROLLBACK_COPY" : "RETAINED_ORIGINAL";
    }
    if (record.legacyRole !== "NONE") await inspectLegacy(record, roots);
  }

  // 2. Physical references over both locations; duplicates = a physical file (or missing legacy path) shared by records.
  const references: Reference[] = [];
  for (const record of records) {
    if (record.physicalFileId && record.actualSizeBytes !== null) {
      references.push({ record, location: "legacy", physicalId: record.physicalFileId, sizeBytes: record.actualSizeBytes });
    }
    const d = record.destination;
    if (d?.physicalFileId && d.actualSizeBytes !== null) references.push({ record, location: "newStorage", physicalId: d.physicalFileId, sizeBytes: d.actualSizeBytes });
  }
  const groups = new Map<string, Set<InventoryRecord>>();
  const addToGroup = (key: string, record: InventoryRecord) => {
    const set = groups.get(key) ?? new Set<InventoryRecord>();
    set.add(record);
    groups.set(key, set);
  };
  for (const reference of references) addToGroup(reference.physicalId, reference.record);
  for (const record of records) {
    if (!record.physicalFileId && record.resolvedPath && record.legacyRole !== "NONE") addToGroup(`missing:${normaliseForCompare(record.resolvedPath)}`, record);
  }
  let duplicateFiles = 0;
  const duplicateRecords = new Set<InventoryRecord>();
  for (const set of groups.values()) {
    if (set.size < 2) continue;
    duplicateFiles++;
    for (const record of set) {
      duplicateRecords.add(record);
      for (const other of set) {
        if (other !== record && !record.sharedWithRecords.some((s) => s.recordId === other.recordId && s.resourceType === other.resourceType)) {
          record.sharedWithRecords.push({ resourceType: other.resourceType, recordId: other.recordId });
        }
      }
      record.issues.push("DUPLICATE_REFERENCE");
    }
  }

  for (const record of records) {
    record.issues = [...new Set(record.issues)].sort();
    record.sharedWithRecords.sort((a, b) => compare(a.resourceType, b.resourceType) || compare(a.recordId, b.recordId));
    record.needsInvestigation = record.issues.some((issue) => !INFORMATIONAL.has(issue));
  }

  // 3. Unreferenced files: legacy folders, and the new storage's Notes / Assignments trees.
  const referencedIds = new Set(references.map((r) => r.physicalId));
  const unreferenced = async (files: ScannedFile[], rootPath: string): Promise<OrphanFile[]> => {
    const out: OrphanFile[] = [];
    for (const file of files) {
      if (referencedIds.has(file.physicalId)) continue;
      const inspection = await inspectFile(rootPath, file.relativePath);
      out.push({
        root: file.root,
        relativePath: file.relativePath,
        sizeBytes: inspection.exists ? inspection.sizeBytes : null,
        sha256: inspection.exists ? inspection.sha256 : null,
        expectedLocation: file.expectedDepth,
        problem: inspection.exists ? null : inspection.problem,
      });
    }
    return out.sort((a, b) => compare(a.relativePath, b.relativePath));
  };
  const legacyScan = await scanLegacyFolders(roots, { maxEntries: input.maxScanEntries });
  const newScan = await scanNewStorage(roots, { maxEntries: input.maxScanEntries });
  const orphanFiles = await unreferenced(legacyScan.files, roots.storage);
  const unreferencedNewStorageFiles = roots.fileStorage ? await unreferenced(newScan.files, roots.fileStorage) : [];
  const unexpectedEntries = [...legacyScan.unexpected, ...newScan.unexpected].sort((a, b) => compare(a.root, b.root) || compare(a.relativePath, b.relativePath));

  // 4. Bytes, once per physical file.
  const physical = new Map<string, { sizeBytes: number; location: "legacy" | "newStorage"; records: Set<InventoryRecord> }>();
  for (const reference of references) {
    const entry = physical.get(reference.physicalId) ?? { sizeBytes: reference.sizeBytes, location: reference.location, records: new Set<InventoryRecord>() };
    entry.records.add(reference.record);
    physical.set(reference.physicalId, entry);
  }

  const byType = { notes: { files: 0, bytes: 0 }, submissions: { files: 0, bytes: 0 }, distinctTotal: { files: 0, bytes: 0 } };
  const byLocation = { legacy: { files: 0, bytes: 0 }, newStorage: { files: 0, bytes: 0 } };
  const softDeletedNotes = { records: records.filter((r) => r.resourceType === "NOTE" && r.softDeleted).length, filesOnDisk: 0, bytesOnDisk: 0 };
  const teachers = new Map<string, TeacherUsage>();
  const ownershipConflicts: InventoryReport["ownershipConflicts"] = [];

  const usage = (teacherId: string): TeacherUsage => {
    let entry = teachers.get(teacherId);
    if (!entry) {
      entry = {
        teacherId,
        notesActiveBytes: 0,
        notesActiveFiles: 0,
        notesSoftDeletedBytes: 0,
        notesSoftDeletedFiles: 0,
        submissionsBytes: 0,
        submissionsFiles: 0,
        legacyBytes: 0,
        newStorageBytes: 0,
        totalBytes: 0,
      };
      teachers.set(teacherId, entry);
    }
    return entry;
  };

  for (const [physicalFileId, entry] of [...physical.entries()].sort((a, b) => compare(a[0], b[0]))) {
    const size = entry.sizeBytes;
    const owners = [...entry.records];
    byType.distinctTotal.files++;
    byType.distinctTotal.bytes += size;
    byLocation[entry.location].files++;
    byLocation[entry.location].bytes += size;
    const notes = owners.filter((r) => r.resourceType === "NOTE");
    const submissions = owners.filter((r) => r.resourceType === "ASSIGNMENT_SUBMISSION");
    if (notes.length > 0) {
      byType.notes.files++;
      byType.notes.bytes += size;
    }
    if (submissions.length > 0) {
      byType.submissions.files++;
      byType.submissions.bytes += size;
    }
    // A file only soft-deleted notes reference is soft-deleted disk use (approved: it still counts).
    const noteFileSoftDeletedOnly = notes.length > 0 && notes.every((r) => r.softDeleted);
    if (noteFileSoftDeletedOnly && submissions.length === 0) {
      softDeletedNotes.filesOnDisk++;
      softDeletedNotes.bytesOnDisk += size;
    }

    const teacherIds = [...new Set(owners.map((r) => r.teacherId))];
    if (teacherIds.length !== 1 || teacherIds[0] === null) {
      ownershipConflicts.push({
        physicalFileId,
        teacherIds: teacherIds.filter((id): id is string => id !== null).sort(),
        records: owners.map((r) => ({ resourceType: r.resourceType, recordId: r.recordId })).sort((a, b) => compare(a.recordId, b.recordId)),
      });
      continue;
    }
    const teacher = usage(teacherIds[0]);
    teacher.totalBytes += size;
    if (entry.location === "legacy") teacher.legacyBytes += size;
    else teacher.newStorageBytes += size;
    if (submissions.length > 0 && notes.length === 0) {
      teacher.submissionsBytes += size;
      teacher.submissionsFiles++;
    } else if (noteFileSoftDeletedOnly) {
      teacher.notesSoftDeletedBytes += size;
      teacher.notesSoftDeletedFiles++;
    } else {
      teacher.notesActiveBytes += size;
      teacher.notesActiveFiles++;
    }
  }

  const noteRecords = records.filter((r) => r.resourceType === "NOTE");
  const submissionRecords = records.filter((r) => r.resourceType === "ASSIGNMENT_SUBMISSION");
  const has = (r: InventoryRecord, ...issues: RecordIssue[]) => issues.some((issue) => r.issues.includes(issue));
  const withRole = (role: LegacyRole) => records.filter((r) => r.legacyRole === role);
  const roleStats = (role: LegacyRole) => ({
    records: withRole(role).length,
    missing: withRole(role).filter((r) => has(r, "LEGACY_COPY_MISSING")).length,
    hashMismatches: withRole(role).filter((r) => has(r, "LEGACY_COPY_HASH_MISMATCH")).length,
  });
  const withLegacyFile = records.filter((r) => r.legacyRole !== "NONE");

  const summary: InventorySummary = {
    notes: {
      total: noteRecords.length,
      active: noteRecords.filter((r) => !r.softDeleted).length,
      softDeleted: noteRecords.filter((r) => r.softDeleted).length,
      hiddenByParent: noteRecords.filter((r) => r.hiddenByParent).length,
    },
    submissions: { total: submissionRecords.length, hiddenByParent: submissionRecords.filter((r) => r.hiddenByParent).length },
    storage: {
      legacyRecords: records.filter((r) => r.storageState === "LEGACY").length,
      migratedRecords: records.filter((r) => r.storageState === "MIGRATED").length,
      migratedWithProblems: records.filter((r) => r.storageState === "MIGRATED_WITH_PROBLEMS").length,
      destinationMissing: records.filter((r) => has(r, "DESTINATION_MISSING")).length,
      destinationSizeMismatches: records.filter((r) => has(r, "DESTINATION_SIZE_MISMATCH")).length,
      destinationHashMismatches: records.filter((r) => has(r, "DESTINATION_HASH_MISMATCH")).length,
      invalidStorageKeys: records.filter((r) => has(r, "INVALID_STORAGE_KEY")).length,
      rollbackCopies: roleStats("ROLLBACK_COPY"),
      retainedOriginals: roleStats("RETAINED_ORIGINAL"),
      unreferencedNewStorageFiles: { count: unreferencedNewStorageFiles.length, bytes: unreferencedNewStorageFiles.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0) },
    },
    existingFiles: withLegacyFile.filter((r) => r.fileExists).length,
    missingFiles: records.filter((r) => has(r, "FILE_MISSING")).length,
    sizeMismatches: records.filter((r) => has(r, "SIZE_MISMATCH")).length,
    duplicatePhysicalReferences: { physicalFiles: duplicateFiles, records: duplicateRecords.size },
    orphanFiles: { count: orphanFiles.length, bytes: orphanFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) },
    legacyUploadsReferences: records.filter((r) => r.legacyUploadsReference).length,
    unsafeOrInvalidReferences: records.filter((r) => has(r, "UNSAFE_PATH", "INVALID_REFERENCE")).length,
    symlinksEncountered:
      records.filter((r) => has(r, "SYMLINK_IN_PATH") || r.destination?.problem === "SYMLINK_IN_PATH").length + unexpectedEntries.filter((e) => e.kind === "symlink").length,
    unexpectedEntries: unexpectedEntries.length,
    bytesByResourceType: byType,
    bytesByLocation: byLocation,
    softDeletedNotes,
    teachers: teachers.size,
    ownershipConflicts: ownershipConflicts.length,
    recordsNeedingInvestigation: records.filter((r) => r.needsInvestigation).length,
    scanTruncated: legacyScan.truncated || newScan.truncated,
  };

  const content = {
    reportVersion: INVENTORY_REPORT_VERSION,
    database: { host: "loopback" as const, databaseName: input.database.databaseName },
    roots: { storage: roots.storage, publicUploads: roots.publicUploads, fileStorage: roots.fileStorage },
    scannedFolders: [...legacyScan.folders, ...newScan.folders],
    notScanned: [
      "public/uploads (other features keep files there; only the referenced /uploads/ files are inspected)",
      "storage/* folders of other features (breakout-activities, class-papers, material-bundles, ...)",
      ...(roots.fileStorage ? [] : ["the new storage (no --file-storage-root given): stored records cannot be verified"]),
    ],
    summary,
    bytesByTeacher: [...teachers.values()].sort((a, b) => compare(a.teacherId, b.teacherId)),
    ownershipConflicts,
    records,
    orphanFiles,
    unreferencedNewStorageFiles,
    unexpectedEntries,
    manualInvestigation: records
      .filter((r) => r.needsInvestigation)
      .map((r) => ({ resourceType: r.resourceType, recordId: r.recordId, issues: r.issues.filter((issue) => !INFORMATIONAL.has(issue)) })),
  };

  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const { reportVersion, ...rest } = content;
  return { reportVersion, generatedAt, contentDigest: digestOf(content), ...rest };
}

// ---- Readable summary ---------------------------------------------------------------------------------------

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

/** Counts and totals only (no ids, paths or file names): safe for ordinary console output. */
export function formatConsoleSummary(report: InventoryReport): string[] {
  const s = report.summary;
  const st = s.storage;
  return [
    `Storage inventory (report v${report.reportVersion}, database "${report.database.databaseName}" on loopback)`,
    `  Notes:                 ${s.notes.total} (active ${s.notes.active}, soft-deleted ${s.notes.softDeleted}, hidden by a removed lecture/class ${s.notes.hiddenByParent})`,
    `  Submissions:           ${s.submissions.total} (hidden by a removed assignment/lecture/class ${s.submissions.hiddenByParent})`,
    `  Legacy records:        ${st.legacyRecords}`,
    `  Migrated records:      ${st.migratedRecords} verified, ${st.migratedWithProblems} with problems`,
    `  New storage problems:  missing ${st.destinationMissing}, size ${st.destinationSizeMismatches}, hash ${st.destinationHashMismatches}, invalid key ${st.invalidStorageKeys}`,
    `  Rollback copies:       ${st.rollbackCopies.records} (missing ${st.rollbackCopies.missing}, hash mismatch ${st.rollbackCopies.hashMismatches})`,
    `  Retained originals:    ${st.retainedOriginals.records} (missing ${st.retainedOriginals.missing}, hash mismatch ${st.retainedOriginals.hashMismatches})`,
    `  Unreferenced new files:${st.unreferencedNewStorageFiles.count} (${mib(st.unreferencedNewStorageFiles.bytes)})`,
    `  Legacy files found:    ${s.existingFiles}`,
    `  Missing legacy files:  ${s.missingFiles}`,
    `  Size mismatches:       ${s.sizeMismatches}`,
    `  Duplicate references:  ${s.duplicatePhysicalReferences.physicalFiles} file(s) shared by ${s.duplicatePhysicalReferences.records} record(s)`,
    `  Orphan legacy files:   ${s.orphanFiles.count} (${mib(s.orphanFiles.bytes)})`,
    `  /uploads/ references:  ${s.legacyUploadsReferences}`,
    `  Unsafe/invalid paths:  ${s.unsafeOrInvalidReferences}`,
    `  Symbolic links:        ${s.symlinksEncountered}`,
    `  Unexpected entries:    ${s.unexpectedEntries}`,
    `  Notes bytes:           ${mib(s.bytesByResourceType.notes.bytes)} in ${s.bytesByResourceType.notes.files} file(s)`,
    `  Submission bytes:      ${mib(s.bytesByResourceType.submissions.bytes)} in ${s.bytesByResourceType.submissions.files} file(s)`,
    `  By location:           legacy ${mib(s.bytesByLocation.legacy.bytes)} (${s.bytesByLocation.legacy.files}), new storage ${mib(s.bytesByLocation.newStorage.bytes)} (${s.bytesByLocation.newStorage.files})`,
    `  Soft-deleted notes:    ${s.softDeletedNotes.records} record(s), ${s.softDeletedNotes.filesOnDisk} file(s), ${mib(s.softDeletedNotes.bytesOnDisk)} on disk`,
    `  Teachers with files:   ${s.teachers} (ownership conflicts ${s.ownershipConflicts})`,
    `  Need investigation:    ${s.recordsNeedingInvestigation} record(s)`,
    ...(report.roots.fileStorage ? [] : ["  NOTE: no --file-storage-root given: records in the new storage were not verified."]),
    ...(s.scanTruncated ? ["  WARNING: a scan hit its entry limit; orphan / unreferenced counts are incomplete."] : []),
    `  Content digest:        ${report.contentDigest}`,
  ];
}

/** The readable summary file: the console summary plus per-teacher totals and the records to investigate (ids only). */
export function formatSummaryFile(report: InventoryReport): string {
  const lines = [...formatConsoleSummary(report), "", `Generated at ${report.generatedAt}`, "", "Bytes by teacher (each physical file counted once):"];
  if (report.bytesByTeacher.length === 0) lines.push("  (none)");
  for (const t of report.bytesByTeacher) {
    lines.push(
      `  ${t.teacherId}  total ${mib(t.totalBytes)} (legacy ${mib(t.legacyBytes)}, new ${mib(t.newStorageBytes)}) | notes ${mib(t.notesActiveBytes)} (${t.notesActiveFiles}) | soft-deleted notes ${mib(t.notesSoftDeletedBytes)} (${t.notesSoftDeletedFiles}) | submissions ${mib(t.submissionsBytes)} (${t.submissionsFiles})`
    );
  }
  lines.push("", "Records needing manual investigation:");
  if (report.manualInvestigation.length === 0) lines.push("  (none)");
  for (const item of report.manualInvestigation) lines.push(`  ${item.resourceType} ${item.recordId}: ${item.issues.join(", ")}`);
  lines.push(
    "",
    `Orphan legacy files: ${report.orphanFiles.length}; unreferenced new-storage files: ${report.unreferencedNewStorageFiles.length}; unexpected entries: ${report.unexpectedEntries.length} (paths are in the JSON report).`,
    ""
  );
  return lines.join("\n");
}
