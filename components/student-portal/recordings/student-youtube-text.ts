/*
 * The student Recordings > Live Recordings / YouTube Live Sessions pages'
 * kinds and texts. A plain module (no "use client"): the server page reads the
 * titles here, and the client component imports the same values. A server
 * component must never read values from a "use client" module: on the server
 * its exports are client references, not the values.
 */

export type StudentYouTubeKind = "recordings" | "lives";

export const STUDENT_YOUTUBE_TEXT: Record<StudentYouTubeKind, { title: string; description: string; empty: string; noun: string; player: string }> = {
  recordings: {
    title: "Live Recordings",
    description: "Recordings of your live classes, saved to YouTube by your teachers.",
    empty: "No live recordings here yet.",
    noun: "recordings",
    player: "Live class recording",
  },
  lives: {
    title: "YouTube Live Sessions",
    description: "Your classes' YouTube live streams: watch a live session now, or its replay afterwards.",
    empty: "No YouTube live sessions here yet.",
    noun: "live sessions",
    player: "YouTube live session",
  },
};
