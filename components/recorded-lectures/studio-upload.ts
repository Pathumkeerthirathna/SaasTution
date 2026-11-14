import type { LocalRecording, RecordingStore } from "./recording-store";
import { RecordingUploader, type UploadDeps, type UploadSnapshot } from "./upload-engine";

/*
 * Uploads a reviewed studio recording through the normal upload engine
 * (existing RL-3 protocol). The upload is remembered with the local
 * recording (uploadId), so after a refresh the same upload is resumed from
 * the server's offset instead of starting again. The local copy is deleted
 * ONLY after the server reports the recording READY; on any other outcome it
 * is kept for another try.
 */
export async function uploadLocalRecording(input: {
  store: RecordingStore;
  local: LocalRecording;
  /** The bytes to upload (the reviewed, possibly recovery-trimmed file). */
  blob: Blob;
  title: string;
  partNumber: number;
  fileName: string;
  deps: UploadDeps;
  /** Receives the uploader (pause / cancel). */
  onUploader?: (uploader: RecordingUploader) => void;
}): Promise<UploadSnapshot> {
  const { store, local, blob } = input;
  const resuming = Boolean(local.uploadId) && local.uploadBytes === blob.size;
  const uploader = new RecordingUploader(
    local.lectureId,
    { size: blob.size, slice: (start, end) => blob.slice(start, end) },
    { title: input.title, partNumber: input.partNumber, fileName: input.fileName, sizeBytes: blob.size },
    {
      ...input.deps,
      onUpdate: (snapshot) => {
        input.deps.onUpdate?.(snapshot);
        // Remember the upload as soon as the server created it.
        if (snapshot.uploadId && snapshot.uploadId !== local.uploadId) {
          local.uploadId = snapshot.uploadId;
          void store
            .putRecording({ ...local, status: "uploading", uploadId: snapshot.uploadId, title: input.title, partNumber: input.partNumber, uploadBytes: blob.size, updatedAt: Date.now() })
            .catch(() => undefined);
        }
      },
    },
    resuming ? { uploadId: local.uploadId as string } : undefined
  );
  input.onUploader?.(uploader);
  const result = await uploader.run();
  if (result.phase === "ready") {
    await store.deleteRecording(local.id).catch(() => undefined);
  } else if (result.phase === "expired" || result.phase === "cancelled" || result.phase === "failed") {
    // That upload cannot continue; keep the recording so a NEW upload can be started from it.
    await store.putRecording({ ...local, status: "stopped", uploadId: null, uploadBytes: null, updatedAt: Date.now() }).catch(() => undefined);
  }
  return result;
}
