"use client";


import { useState,useEffect, useRef } from "react";
import { X, ClipboardList, Users } from "lucide-react";

import SidebarNav from "./SidebarNav";
import ParticipantsPanel from "./ParticipantsPanel";
import { ClassroomStudent, JitsiParticipant, UserRole } from "../../types";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "@/components/class-management-panel";
// import AttendancePanel from "./AttendancePanel";
// import ResourcesPanel from "./ResourcesPanel";

type RightSidebarProps = {
  classId : string;
  className : String;
  lectureTitle? : string;
  teacherName : string;
  role : UserRole;
  participants: JitsiParticipant[];
  ClassroomStudents?: ClassroomStudent[];
};

export default function RightSidebar(props: RightSidebarProps) {
  const [activePanel, setActivePanel] = useState<string | null>(null);

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

  }, [activePanel]);



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
          w-[360px]
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

            <h2 className="text-base font-semibold text-[#F8FAFC]">
              {activePanel === "participants" &&
                (props.role === "teacher" ? "Class Register" : "Participants")}

              {activePanel === "attendance" && "Attendance"}

              {activePanel === "resources" && "Resources"}

              {activePanel === "whiteboard" && "Whiteboard"}

              {activePanel === "chat" && "Chat"}

              {activePanel === "quiz" && "Quiz"}

              {activePanel === "notes" && "Notes"}
            </h2>

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

        <div className="h-[calc(100%-65px)] overflow-hidden p-3">

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
        />

      </div>

    </div>
  );
}