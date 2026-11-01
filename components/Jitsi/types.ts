export type UserRole = "teacher" | "student";

export type JoinInfo = {
  session: {
    id: string;
    classId: string;
    lectureId?: string | null;
    roomName: string;
    jitsiDomain: string;
  };

  lecture?: {
    id: string;
    title: string;
    date: string;
  } | null;

  class: {
    id: string;
    name: string;
    schedule: string;
  };

  /** e.g. "Mr. Pathum Kumara (Teacher)" — same value for teacher and students. */
  teacherDisplayName?: string;

  /**
   * Student join info only: the class teacher's public profile, for the
   * stage placeholder shown while the teacher's camera is off.
   */
  teacherProfile?: {
    /** e.g. "Mr. Pathum Kumara" (no "(Teacher)" suffix). */
    name: string;
    designation: string | null;
    /** As stored, e.g. "/uploads/teachers/<file>.jpg"; null when none. */
    photoUrl: string | null;
  };

  youtube?: {
    channelTitle: string | null;
    status: "CONNECTED" | "REAUTH_REQUIRED" | null;
  };

  student?: {
    id: string;
    name: string;
    grade: string | null;
  };

  token?: string;
};

export type JitsiApi = {
  executeCommand: (command: string, ...args: unknown[]) => void;
  addListener: (
    event: string,
    listener: (...args: unknown[]) => void
  ) => void;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void
  ) => void;
  getParticipantsInfo: () => Array<{
    participantId: string;
    displayName: string;
  }>;
  dispose: () => void;
};

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: {
        roomName: string;
        parentNode: HTMLElement;
        jwt?: string;
        userInfo?: {
          displayName?: string;
        };
        configOverwrite?: Record<string, unknown>;
        interfaceConfigOverwrite?: Record<string, unknown>;
      }
    ) => JitsiApi;
  }
}

export type ParticipantStatus = {
    audioMuted: boolean;

    videoMuted: boolean;

    raisedHand: boolean;

    isSpeaking: boolean;

    connectionQuality:
        | "excellent"
        | "good"
        | "poor";
};

export type JitsiParticipant = {
    participantId: string;

    displayName: string;

    avatarURL?: string;

    role: "moderator" | "participant";

    status: ParticipantStatus;
};

export type ClassroomStudent = {
  studentId: string;
  displayName: string;
  email: string | null;
};

export type ChatMessage = {
  id: string;
  /** Display name of the sender. */
  author: string;
  body: string;
  /** ISO-8601 timestamp. */
  at: string;
  /** True when this device sent the message. */
  self: boolean;
};
/* ------------------------------ Breakout rooms ------------------------------ */

export type BreakoutParticipant = {
  /** The rooms list key: the occupant JID "<room>@<muc>/<participantId>". Unique per room. */
  occupantJid: string;
  /**
   * The Jitsi participant ID, parsed from `occupantJid` (participantIdFromRoomKey);
   * null when the key is not of that form. Identity is matched on this only.
   */
  participantId: string | null;
  /**
   * The participant's real XMPP address, exactly as Jitsi reports it. This is
   * what `sendParticipantToRoom` accepts for anyone, wherever they are. Never
   * used for identity. Null when Jitsi did not report one (cannot be moved).
   */
  jid: string | null;
  /** Display only (empty when Jitsi reports none); never used for identity. */
  displayName: string;
};

export type BreakoutRoom = {
  /** Used by `sendParticipantToRoom` and `closeBreakoutRoom`. For breakout rooms it is also the Jitsi room name. */
  id: string;
  /** Used by `joinBreakoutRoom` and `removeBreakoutRoom`. */
  jid: string;
  name: string;
  isMainRoom: boolean;
  participants: BreakoutParticipant[];
};

/** The Jitsi room this browser is currently in. */
export type CurrentRoomInfo = {
  roomName: string;
  isBreakoutRoom: boolean;
};
