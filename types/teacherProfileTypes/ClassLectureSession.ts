type ClassLectureRecordingBase = {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
};

/**
 * A recording as the PUBLIC class pages see it. Only a FREE recording carries
 * its YouTube video ID / URL; a LOCKED one is listed (so the page can show it
 * behind a lock) without them, so its unlisted video cannot be found from the
 * page or its payload.
 */
export type ClassLectureRecording =
  | (ClassLectureRecordingBase & { access: "FREE"; videoId: string; youtubeUrl: string })
  | (ClassLectureRecordingBase & { access: "LOCKED"; videoId: null; youtubeUrl: null });

type ClassLectureUploadedRecordingBase = {
  source: "UPLOAD";
  id: string;
  title: string;
  partNumber: number;
  durationSeconds: number | null;
};

/**
 * An UPLOADED recorded lecture as the PUBLIC class pages see it
 * (services/recorded-lecture-public-service.ts). Only a FREE ("Unlocked")
 * one carries its stream URL (the public stream endpoint, authorised again
 * on every request); a LOCKED one is listed behind a lock without it.
 */
export type ClassLectureUploadedRecording =
  | (ClassLectureUploadedRecordingBase & { access: "FREE"; streamUrl: string })
  | (ClassLectureUploadedRecordingBase & { access: "LOCKED"; streamUrl: null });

export interface ClassLectureSession {
  id: string;
  title: string;
  date: string;
  createdAt: string;
  recordings: ClassLectureRecording[];
  /** Uploaded recordings of this lecture, by part number. Absent when there are none. */
  uploads?: ClassLectureUploadedRecording[];
}
