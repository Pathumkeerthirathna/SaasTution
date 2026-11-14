import type { FileStorage } from "@/lib/file-storage/types";

import { inspectMp4, type Mp4InspectionResult } from "./mp4-inspect";
import type { RecordedLectureConfig } from "./config";

/*
 * Server side of the MP4 validation (RL-1): inspects a stored file through
 * the storage layer (random-access reads of box headers and the bounded
 * moov box only; the media data is never read into memory).
 */

export async function inspectStoredMp4(
  storage: Pick<FileStorage, "openByteSource">,
  key: string,
  config: Pick<RecordedLectureConfig, "maxMoovBytes">
): Promise<Mp4InspectionResult> {
  const source = await storage.openByteSource(key);
  try {
    return await inspectMp4(source, { maxMoovBytes: config.maxMoovBytes });
  } finally {
    await source.close();
  }
}
