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