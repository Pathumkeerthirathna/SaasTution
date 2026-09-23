// Mirrors the phone/touch-layout detection in ../hooks/useClassroomViewport.ts
// (same query strings, same isPhone || (isShort && isCoarse) formula).
// Duplicated here rather than imported: useClassroomViewport is a React hook,
// but these arrays are read once, directly, by useJitsi.ts when it constructs
// JitsiMeetExternalAPI — not from a component that could call a hook.
const PHONE_QUERY = "(max-width: 639px) and (min-height: 501px)";
const SHORT_QUERY = "(max-height: 500px)";
const COARSE_QUERY = "(pointer: coarse)";

function isMobileTouchLayout(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  const isPhone = window.matchMedia(PHONE_QUERY).matches;
  const isShort = window.matchMedia(SHORT_QUERY).matches;
  const isCoarse = window.matchMedia(COARSE_QUERY).matches;

  return isPhone || (isShort && isCoarse);
}

// Evaluated once, at module load (matching how these arrays are already only
// ever read once, at Jitsi construction time) — not reactive to later resize
// or rotation, which is fine since the toolbar itself is never reconfigured
// after the conference is created.
const isMobile = isMobileTouchLayout();

const baseTeacherToolbar = [
  "microphone",
  "camera",
  "desktop",
  // "chat",
  // "participants-pane",
  //"raisehand",
  "hangup",
  "fullscreen",
  //"tileview",
  "filmstrip",
  "settings",
  "videoquality",
  "select-background",
  "videobackgroundblur",
  "noisesuppression",
  "mute-everyone",
  "security",
  "whiteboard",
  "breakoutrooms",
  // "recording",
  "livestreaming",
  // "sharedvideo",
  "etherpad",
  //"invite",
  "calendar",
  "closedcaptions",
  "profile",
  "feedback",
  "help",
  "speakerstats",
  "stats",
  "shortcuts",
  "download",
  "embedmeeting",
  "fodeviceselection",
  "toggle-camera",
];

const baseStudentToolbar = [
  "microphone",
  "camera",
  // "chat",
  "raisehand",
  // "participants-pane",
  "tileview",
  "fullscreen",
  "settings",
  "videoquality",
  "shortcuts",
  "hangup",
  "desktop"
];

// Jitsi's own native "fullscreen" toolbar button only fullscreens its own
// (the iframe's) document — on mobile the SL Classroom app provides its own
// fullscreen control instead (see MeetingCard.tsx / JitsiClassroom.tsx), so
// Jitsi's native one is dropped there to keep exactly one fullscreen entry
// point per device class. Desktop keeps it, unchanged.
export const teacherToolbar = isMobile
  ? baseTeacherToolbar.filter((button) => button !== "fullscreen")
  : baseTeacherToolbar;

export const studentToolbar = isMobile
  ? baseStudentToolbar.filter((button) => button !== "fullscreen")
  : baseStudentToolbar;
