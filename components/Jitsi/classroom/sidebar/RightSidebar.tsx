"use client";


import { useState,useEffect, useRef } from "react";
import {
  X,
  ClipboardList,
  Users,
  FileText,
  ListChecks,
} from "lucide-react";

import SidebarNav from "./SidebarNav";
import ParticipantsPanel from "./ParticipantsPanel";
import { ClassroomStudent, JitsiParticipant, UserRole } from "../../types";
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
};

export default function RightSidebar(props: RightSidebarProps) {
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const showLectureTools =
    props.role === "teacher" && Boolean(props.lectureId);

  const isLectureToolPanel = LECTURE_TOOL_PANELS.includes(
    activePanel as (typeof LECTURE_TOOL_PANELS)[number]
  );

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

  // The lecture tool panels open their own modals/drawers outside this
  // container — don't collapse the sidebar when the teacher interacts with them.
  if (isLectureToolPanel) {
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

  }, [activePanel, isLectureToolPanel]);



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
          ${isLectureToolPanel ? "w-[460px] max-w-[92vw]" : "w-[360px]"}
          overflow-hidden
          border-l
          border-[#1E293B]
          bg-[#0F172A]
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

        <div className="flex items-center justify-between border-b border-[#1E293B] px-5 py-4">

          <div className="flex items-center gap-2">

            {activePanel === "participants" &&
              (props.role === "teacher" ? (
                <ClipboardList size={18} className="text-[#3B82F6]" />
              ) : (
                <Users size={18} className="text-[#3B82F6]" />
              ))}

            {activePanel === "notes" && (
              <FileText size={18} className="text-[#3B82F6]" />
            )}
            {activePanel === "assignments" && (
              <ClipboardList size={18} className="text-[#3B82F6]" />
            )}
            {activePanel === "quiz" && (
              <ListChecks size={18} className="text-[#3B82F6]" />
            )}

            <div>
              <h2 className="text-base font-semibold text-[#F8FAFC]">
                {activePanel === "participants" &&
                  (props.role === "teacher" ? "Class Register" : "Participants")}

                {activePanel === "attendance" && "Attendance"}

                {activePanel === "resources" && "Resources"}

                {activePanel === "whiteboard" && "Whiteboard"}

                {activePanel === "chat" && "Chat"}

                {activePanel === "quiz" && "Quizzes"}

                {activePanel === "assignments" && "Assignments"}

                {activePanel === "notes" && "Notes"}
              </h2>

              {isLectureToolPanel && props.lectureTitle ? (
                <p className="max-w-[300px] truncate text-[11px] text-[#94A3B8]">
                  {props.lectureTitle}
                </p>
              ) : null}
            </div>

          </div>

          <button
            type="button"
            onClick={closePanel}
            className="rounded-lg p-2 text-[#94A3B8] transition hover:bg-[#1E293B] hover:text-[#F8FAFC]"
          >
            <X size={18} />
          </button>

        </div>


        {/* Panel Content */}

        <div
          className={`h-[calc(100%-72px)] ${
            isLectureToolPanel ? "overflow-y-auto scrollbar-thin bg-white" : "overflow-hidden p-3"
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
            />
          )}

          {showLectureTools && props.lectureId && activePanel === "notes" && (
            <div className="p-3 text-slate-900">
              <LectureNotePanel lectureId={props.lectureId} />
            </div>
          )}

          {showLectureTools && props.lectureId && activePanel === "assignments" && (
            <div className="p-3 text-slate-900">
              <LectureAssignmentPanel lectureId={props.lectureId} />
            </div>
          )}

          {showLectureTools && props.lectureId && activePanel === "quiz" && (
            <div className="p-3 text-slate-900">
              <LectureQuizPanel lectureId={props.lectureId} />
            </div>
          )}

          {/* Later */}

          {/* {activePanel === "attendance" && (
            <AttendancePanel />
          )}

          {activePanel === "resources" && (
            <ResourcesPanel />
          )} */}

        </div>

      </div>


      {/* ========================= */}
      {/* RIGHT TOOL RAIL */}
      {/* ========================= */}

      <div
        className="
          absolute
          right-0
          top-[104px]
          bottom-0
          z-50
          w-[72px]
          border-l
          border-[#1E293B]
          bg-[#0F172A]
        "
      >

        <SidebarNav
          activePanel={activePanel}
          onPanelChange={handlePanelChange}
          showLectureTools={showLectureTools}
        />

      </div>

    </div>
  );
}