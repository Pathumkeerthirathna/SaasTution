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

export interface ClassLectureSession {
  id: string;
  title: string;
  date: string;
  createdAt: string;
  recordings: ClassLectureRecording[];
}
