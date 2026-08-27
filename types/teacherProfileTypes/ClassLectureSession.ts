export interface ClassLectureRecording {
  id: string;
  videoId: string;
  youtubeUrl: string;
  access: "FREE" | "LOCKED";
  startedAt: string | null;
  endedAt: string | null;
}

export interface ClassLectureSession {
  id: string;
  title: string;
  date: string;
  createdAt: string;
  recordings: ClassLectureRecording[];
}
