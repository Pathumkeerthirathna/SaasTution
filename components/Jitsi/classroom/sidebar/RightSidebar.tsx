"use client";


import { useState,useEffect, useMemo, useRef } from "react";
import {
  X,
  ClipboardList,
  ClipboardCheck,
  Users,
  FileText,
  ListChecks,
  MessageSquare,
} from "lucide-react";

import SidebarNav from "./SidebarNav";
import ParticipantsPanel from "./ParticipantsPanel";
import AttendancePanel from "./AttendancePanel";
import ChatPanel from "./ChatPanel";
import StudentNotesPanel from "../student/StudentNotesPanel";
import StudentAssignmentsPanel from "../student/StudentAssignmentsPanel";
import StudentQuizzesPanel from "../student/StudentQuizzesPanel";
import { ChatMessage, ClassroomStudent, JitsiParticipant, UserRole } from "../../types";
import { LectureNotePanel } from "@/components/lecture-note-panel";
import { LectureAssignmentPanel } from "@/components/lecture-assignment-panel";
import { LectureQuizPanel } from "@/components/lecture-quiz-panel";

const LECTURE_TOOL_PANELS = ["notes", "assignments", "quiz"] as const;

type RightSidebarProps = {
  classId : string;
  className : String;
  lectureId? : string | null;
  lectureTitle? : string;
  teacherName : string;
  role : UserRole;
  participants: JitsiParticipant[];
  ClassroomStudents?: ClassroomStudent[];
  onMuteEveryone?: () => void;
  onMuteParticipant?: (participantId: string, muted: boolean) => void;
  chatMessages?: ChatMessage[];
  onSendChat?: (message: string) => void;
  onSetVideoQuality?: (heightPx: number) => void;
  onSetNoiseSuppression?: (enabled: boolean) => void;
};

export default function RightSidebar(props: RightSidebarProps) {
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const isTeacher = props.role === "teacher";
  const isStudent = props.role === "student";
  const hasLecture = Boolean(props.lectureId);

  // The Notes / Assignments / Quizzes rail tools show whenever the session is
  // bound to a lecture — teachers manage them, students read + submit their own.
  const showLectureTools = hasLecture;

  const isLectureToolPanel = LECTURE_TOOL_PANELS.includes(
    activePanel as (typeof LECTURE_TOOL_PANELS)[number]
  );

  const isTeacherLecturePanel = isTeacher && hasLecture && isLectureToolPanel;
  const isStudentLecturePanel = isStudent && hasLecture && isLectureToolPanel;
  const isAttendancePanel = isTeacher && activePanel === "attendance";
  const isChatPanel = activePanel === "chat";

  // The teacher's "Class Register" (participants panel) is styled like the
  // lecture tool panels: blue header, light body.
  const isClassRegister =
    props.role === "teacher" && activePanel === "participants";
  // The student's "Participants" list gets the same light body treatment.
  const isStudentParticipants = isStudent && activePanel === "participants";

  // Session chrome (rail + panel shell + header) is navy/blue for the teacher
  // and green for the student — the panel bodies underneath keep their own
  // (already-green) theming regardless.
  const chrome = isStudent
    ? {
        // Muted, desaturated dark green — less "vivid emerald", more a green-tinted charcoal.
        panelBg: "bg-[#10231D]",
        panelBorder: "border-[#1C332B]",
        iconAccent: "text-white/80",
        title: "text-white",
        subtitle: "text-[#9FB6AC]/70",
        closeIdle: "text-[#9FB6AC]/70",
        closeHover: "hover:bg-[#22392F] hover:text-white",
      }
    : {
        panelBg: "bg-[#112D5C]",
        panelBorder: "border-[#1E293B]",
        iconAccent: "text-[#3B82F6]",
        title: "text-[#F8FAFC]",
        subtitle: "text-[#94A3B8]",
        closeIdle: "text-[#94A3B8]",
        closeHover: "hover:bg-[#1E293B] hover:text-[#F8FAFC]",
      };

  // Unread chat badge on the rail button — counts messages from others that
  // arrived while the chat panel wasn't open, resets the moment it's opened.
  const chatMessages = useMemo(() => props.chatMessages ?? [], [props.chatMessages]);
  const [chatUnread, setChatUnread] = useState(0);
  const seenChatCountRef = useRef(0);

  useEffect(() => {
    const newOnes = chatMessages.slice(seenChatCountRef.current);
    seenChatCountRef.current = chatMessages.length;

    if (activePanel === "chat") {
      setChatUnread(0);
      return;
    }

    const newRemoteCount = newOnes.filter((m) => !m.self).length;
    if (newRemoteCount > 0) {
      setChatUnread((prev) => prev + newRemoteCount);
    }
  }, [chatMessages, activePanel]);

  const handlePanelChange = (panel: string) => {
    setActivePanel((current) =>
      current === panel ? null : panel
    );
  };

  const closePanel = () => {
    setActivePanel(null);
  };

  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    console.log(
      "🟢 RightSidebar participants updated:",
      props.participants
    );

    console.log(
      "🟢 Participant count:",
      props.participants.length
    );
  }, [props.participants]);

  useEffect(() => {
    console.log(
      "🟢 RIGHT SIDEBAR AUDIO STATES:",
      props.participants.map(p => ({
        id: p.participantId,
        name: p.displayName,
        muted: p.status.audioMuted,
      }))
    );
  }, [props.participants]);

  useEffect(() => {

  if (!activePanel) {
    return;
  }

  // The lecture tool panels (and the Class Register, whose "Notify" dialog is a
  // full-screen overlay) open their own modals outside this container — don't
  // collapse the sidebar when the teacher interacts with them.
  if (isLectureToolPanel || isClassRegister) {
    return;
  }

  const handleOutsideClick = (event: MouseEvent) => {

      const target = event.target as Node;

      if (
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setActivePanel(null);
      }

    };

    document.addEventListener(
      "mousedown",
      handleOutsideClick
    );

    return () => {
      document.removeEventListener(
        "mousedown",
        handleOutsideClick
      );
    };

  }, [activePanel, isLectureToolPanel, isClassRegister]);



  return (
    <div className="relative h-full">

      {/* ========================= */}
      {/* SLIDE-OUT PANEL */}
      {/* ========================= */}

      <div
        ref={panelRef}
        className={`
          absolute
          right-[72px]
          top-[80px]
          bottom-0
          z-40
          ${isLectureToolPanel || isClassRegister || isAttendancePanel ? "w-[460px] max-w-[92vw]" : "w-[360px]"}
          overflow-hidden
          border-l
          ${chrome.panelBorder}
          ${chrome.panelBg}
          shadow-2xl
          transition-all
          duration-300
          ease-in-out
          ${
            activePanel
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-4 opacity-0"
          }
        `}
      >

        {/* Panel Header */}

        <div className={`flex items-center justify-between border-b ${chrome.panelBorder} px-5 py-4`}>

          <div className="flex items-center gap-2">

            {activePanel === "participants" &&
              (props.role === "teacher" ? (
                <ClipboardList size={18} className={chrome.iconAccent} />
              ) : (
                <Users size={18} className={chrome.iconAccent} />
              ))}

            {activePanel === "attendance" && (
              <ClipboardCheck size={18} className={chrome.iconAccent} />
            )}
            {activePanel === "chat" && (
              <MessageSquare size={18} className={chrome.iconAccent} />
            )}
            {activePanel === "notes" && (
              <FileText size={18} className={chrome.iconAccent} />
            )}
            {activePanel === "assignments" && (
              <ClipboardList size={18} className={chrome.iconAccent} />
            )}
            {activePanel === "quiz" && (
              <ListChecks size={18} className={chrome.iconAccent} />
            )}

            <div>
              <h2 className={`text-base font-semibold ${chrome.title}`}>
                {activePanel === "participants" &&
                  (props.role === "teacher" ? "Class Register" : "Participants")}

                {activePanel === "attendance" && "Attendance"}

                {activePanel === "whiteboard" && "Whiteboard"}

                {activePanel === "chat" && "Chat"}

                {activePanel === "quiz" && "Quizzes"}

                {activePanel === "assignments" && "Assignments"}

                {activePanel === "notes" && "Notes"}
              </h2>

              {isLectureToolPanel && props.lectureTitle ? (
                <p className={`max-w-[300px] truncate text-[11px] ${chrome.subtitle}`}>
                  {props.lectureTitle}
                </p>
              ) : (isClassRegister || isAttendancePanel) && props.className ? (
                <p className={`max-w-[300px] truncate text-[11px] ${chrome.subtitle}`}>
                  {props.className}
                </p>
              ) : null}
            </div>

          </div>

          <button
            type="button"
            onClick={closePanel}
            className={`rounded-lg p-2 transition ${chrome.closeIdle} ${chrome.closeHover}`}
          >
            <X size={18} />
          </button>

        </div>


        {/* Panel Content */}

        <div
          className={`h-[calc(100%-72px)] ${
            isTeacherLecturePanel
              ? "overflow-y-auto scrollbar-thin bg-white"
              : isStudentLecturePanel
                ? "overflow-y-auto scrollbar-thin bg-emerald-50/40"
                : isClassRegister || isAttendancePanel || isChatPanel || isStudentParticipants
                  ? "overflow-hidden bg-white p-3 text-slate-900"
                  : "overflow-hidden p-3"
          }`}
        >

          {activePanel === "participants" && (
            <ParticipantsPanel
              participants={props.participants}
              ClassroomStudents={props.ClassroomStudents}
              role = {props.role}
              lectureTitle={props.lectureTitle}
              className={props.className as string}
              classId={props.classId}
              onMuteEveryone={props.onMuteEveryone}
              onMuteParticipant={props.onMuteParticipant}
            />
          )}

          {isAttendancePanel && (
            <AttendancePanel
              classId={props.classId}
              participants={props.participants}
            />
          )}

          {activePanel === "chat" && (
            <ChatPanel
              messages={chatMessages}
              onSend={(text) => props.onSendChat?.(text)}
            />
          )}

          {/* Teacher: manage lecture tools */}
          {isTeacher && props.lectureId && activePanel === "notes" && (
            <div className="p-3 text-slate-900">
              <LectureNotePanel lectureId={props.lectureId} />
            </div>
          )}

          {isTeacher && props.lectureId && activePanel === "assignments" && (
            <div className="p-3 text-slate-900">
              <LectureAssignmentPanel lectureId={props.lectureId} />
            </div>
          )}

          {isTeacher && props.lectureId && activePanel === "quiz" && (
            <div className="p-3 text-slate-900">
              <LectureQuizPanel lectureId={props.lectureId} />
            </div>
          )}

          {/* Student: read + submit their own work */}
          {isStudent && props.lectureId && activePanel === "notes" && (
            <div className="p-3">
              <StudentNotesPanel lectureId={props.lectureId} />
            </div>
          )}

          {isStudent && props.lectureId && activePanel === "assignments" && (
            <div className="p-3">
              <StudentAssignmentsPanel lectureId={props.lectureId} />
            </div>
          )}

          {isStudent && props.lectureId && activePanel === "quiz" && (
            <div className="p-3">
              <StudentQuizzesPanel lectureId={props.lectureId} />
            </div>
          )}

        </div>

      </div>


      {/* ========================= */}
      {/* RIGHT TOOL RAIL */}
      {/* ========================= */}

      {/* Fills the gap above the rail (behind the meeting header) with the same
          rail color, so there's no black seam for either role. */}
      <div
        className={`absolute right-0 top-0 z-50 h-[104px] w-[72px] border-l ${chrome.panelBorder} ${chrome.panelBg}`}
      />

      <div
        className={`
          absolute
          right-0
          top-[104px]
          bottom-0
          z-50
          w-[72px]
          border-l
          ${chrome.panelBorder}
          ${chrome.panelBg}
        `}
      >

        <SidebarNav
          activePanel={activePanel}
          onPanelChange={handlePanelChange}
          showLectureTools={showLectureTools}
          showAttendance={isTeacher}
          chatUnread={chatUnread}
          variant={isStudent ? "student" : "teacher"}
          showSettings={isTeacher}
          onSetVideoQuality={props.onSetVideoQuality}
          onSetNoiseSuppression={props.onSetNoiseSuppression}
        />

      </div>

    </div>
  );
}