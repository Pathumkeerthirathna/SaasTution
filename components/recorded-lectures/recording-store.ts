/*
 * Browser-side persistence for the Recording Studio and resumable uploads.
 *
 * Why IndexedDB: a recording is written as it is made (MediaRecorder
 * timeslices) so a long lesson is not held only in memory, and a recording
 * or an upload interrupted by a refresh / crash can be found again. Blobs
 * stored in IndexedDB are kept by the browser on disk, and a Blob assembled
 * from them is read lazily (slices) during upload: the whole video is never
 * loaded into memory by this code.
 *
 * LIMITS (honest): browser storage can be cleared by the user or evicted
 * under storage pressure (navigator.storage.persist() is requested, but the
 * browser decides); private windows may not keep it; a quota error stops the
 * recording with a message. Recovery is therefore best effort, never
 * guaranteed. Everything is kept per teacher and lecture and removed after a
 * successful upload (or when the teacher discards it).
 *
 * For a FILE upload no video bytes are copied: only the upload's identity and
 * a fingerprint of the file, so after a refresh the teacher re-selects the
 * same file and it is checked before any byte is sent.
 */

export type LocalRecordingStatus = "recording" | "stopped" | "uploading";

export type LocalRecording = {
  id: string;
  teacherId: string;
  lectureId: string;
  mimeType: string;
  startedAt: number;
  updatedAt: number;
  status: LocalRecordingStatus;
  durationMs: number;
  /** Set once an upload was started for it. */
  uploadId: string | null;
  title: string | null;
  partNumber: number | null;
  /** Size of the bytes to upload (after a recovery trim). */
  uploadBytes: number | null;
};

export type FileFingerprint = { name: string; size: number; lastModified: number; head: string; tail: string };

export type PendingFileUpload = {
  uploadId: string;
  teacherId: string;
  lectureId: string;
  recordingId: string | null;
  fingerprint: FileFingerprint;
  createdAt: number;
};

export interface RecordingStore {
  putRecording(recording: LocalRecording): Promise<void>;
  getRecording(id: string): Promise<LocalRecording | null>;
  listRecordings(teacherId: string, lectureId: string): Promise<LocalRecording[]>;
  appendChunk(recordingId: string, index: number, blob: Blob): Promise<void>;
  /** Every chunk in order, as one lazily read Blob. */
  assemble(recordingId: string, mimeType: string): Promise<Blob>;
  deleteRecording(id: string): Promise<void>;
  putFileUpload(upload: PendingFileUpload): Promise<void>;
  listFileUploads(teacherId: string, lectureId: string): Promise<PendingFileUpload[]>;
  deleteFileUpload(uploadId: string): Promise<void>;
}

// ---- In-memory (tests; and the fallback when IndexedDB is unavailable) --------------------------------------

export function createMemoryStore(): RecordingStore & { readonly persistent: false } {
  const recordings = new Map<string, LocalRecording>();
  const chunks = new Map<string, Map<number, Blob>>();
  const uploads = new Map<string, PendingFileUpload>();
  return {
    persistent: false,
    async putRecording(r) {
      recordings.set(r.id, { ...r });
    },
    async getRecording(id) {
      const r = recordings.get(id);
      return r ? { ...r } : null;
    },
    async listRecordings(teacherId, lectureId) {
      return [...recordings.values()].filter((r) => r.teacherId === teacherId && r.lectureId === lectureId).map((r) => ({ ...r }));
    },
    async appendChunk(recordingId, index, blob) {
      if (!chunks.has(recordingId)) chunks.set(recordingId, new Map());
      chunks.get(recordingId)!.set(index, blob);
    },
    async assemble(recordingId, mimeType) {
      const parts = [...(chunks.get(recordingId)?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([, blob]) => blob);
      return new Blob(parts, { type: mimeType });
    },
    async deleteRecording(id) {
      recordings.delete(id);
      chunks.delete(id);
    },
    async putFileUpload(u) {
      uploads.set(u.uploadId, { ...u });
    },
    async listFileUploads(teacherId, lectureId) {
      return [...uploads.values()].filter((u) => u.teacherId === teacherId && u.lectureId === lectureId);
    },
    async deleteFileUpload(uploadId) {
      uploads.delete(uploadId);
    },
  };
}

// ---- IndexedDB ----------------------------------------------------------------------------------------------

const DB_NAME = "slclassroom-recorded-lectures";
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The IndexedDB store, or null when IndexedDB is unavailable (private mode, blocked site data). */
export async function openIndexedDbStore(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): Promise<
  (RecordingStore & { readonly persistent: true }) | null
> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains("recordings")) d.createObjectStore("recordings", { keyPath: "id" });
        if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { keyPath: ["recordingId", "index"] });
        if (!d.objectStoreNames.contains("fileUploads")) d.createObjectStore("fileUploads", { keyPath: "uploadId" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("blocked"));
    });
  } catch {
    return null;
  }

  return {
    persistent: true,
    async putRecording(r) {
      const tx = db.transaction("recordings", "readwrite");
      tx.objectStore("recordings").put(r);
      await done(tx);
    },
    async getRecording(id) {
      const tx = db.transaction("recordings", "readonly");
      const r = (await request(tx.objectStore("recordings").get(id))) as LocalRecording | undefined;
      return r ?? null;
    },
    async listRecordings(teacherId, lectureId) {
      const tx = db.transaction("recordings", "readonly");
      const all = (await request(tx.objectStore("recordings").getAll())) as LocalRecording[];
      return all.filter((r) => r.teacherId === teacherId && r.lectureId === lectureId);
    },
    async appendChunk(recordingId, index, blob) {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put({ recordingId, index, blob });
      await done(tx);
    },
    async assemble(recordingId, mimeType) {
      const tx = db.transaction("chunks", "readonly");
      const range = IDBKeyRange.bound([recordingId, 0], [recordingId, Number.MAX_SAFE_INTEGER]);
      const rows = (await request(tx.objectStore("chunks").getAll(range))) as { index: number; blob: Blob }[];
      rows.sort((a, b) => a.index - b.index);
      return new Blob(rows.map((row) => row.blob), { type: mimeType });
    },
    async deleteRecording(id) {
      const tx = db.transaction(["recordings", "chunks"], "readwrite");
      tx.objectStore("recordings").delete(id);
      tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      await done(tx);
    },
    async putFileUpload(u) {
      const tx = db.transaction("fileUploads", "readwrite");
      tx.objectStore("fileUploads").put(u);
      await done(tx);
    },
    async listFileUploads(teacherId, lectureId) {
      const tx = db.transaction("fileUploads", "readonly");
      const all = (await request(tx.objectStore("fileUploads").getAll())) as PendingFileUpload[];
      return all.filter((u) => u.teacherId === teacherId && u.lectureId === lectureId);
    },
    async deleteFileUpload(uploadId) {
      const tx = db.transaction("fileUploads", "readwrite");
      tx.objectStore("fileUploads").delete(uploadId);
      await done(tx);
    },
  };
}

/** IndexedDB when available, else memory (then nothing survives a refresh; the UI says so). */
export async function openRecordingStore(): Promise<RecordingStore & { readonly persistent: boolean }> {
  return (await openIndexedDbStore()) ?? createMemoryStore();
}

// ---- File fingerprint (re-selecting the same file after a refresh) ----------------------------------------------

const FINGERPRINT_SAMPLE = 1024 * 1024;

async function sha256Hex(digest: (data: ArrayBuffer) => Promise<ArrayBuffer>, blob: Blob): Promise<string> {
  const hash = new Uint8Array(await digest(await blob.arrayBuffer()));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Name, size, modification time and SHA-256 of the first and last MiB (cheap; not a full-file hash). */
export async function fingerprintFile(
  file: Pick<File, "name" | "size" | "lastModified" | "slice">,
  digest: (data: ArrayBuffer) => Promise<ArrayBuffer> = (data) => crypto.subtle.digest("SHA-256", data)
): Promise<FileFingerprint> {
  const head = await sha256Hex(digest, file.slice(0, Math.min(FINGERPRINT_SAMPLE, file.size)));
  const tail = await sha256Hex(digest, file.slice(Math.max(0, file.size - FINGERPRINT_SAMPLE), file.size));
  return { name: file.name, size: file.size, lastModified: file.lastModified, head, tail };
}

/** Whether a re-selected file is the one the upload was started with. */
export function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.head === b.head && a.tail === b.tail && a.name === b.name;
}
