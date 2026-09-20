"use client";

import {
  ClipboardList,
  Cog,
  MessageSquare,
  MonitorPlay,
  NotebookPen,
  PenTool,
  Radio,
  Users,
  UsersRound,
  Video,
  ListChecks,
  ClipboardCheck,
  BookOpen,
  HelpCircle,
} from "lucide-react";

import HotspotFigure, { type Pin } from "./hotspot-figure";
import PanelTabs, { type PanelTab } from "./panel-tabs";
import Reveal from "./reveal";
import { Container, SectionHead } from "./ui";

const PINS: Pin[] = [
  { id: "stage", label: "Teacher video & screen sharing", text: "Teach on camera or share your screen with the whole class.", x: 40, y: 45, icon: MonitorPlay },
  { id: "people", label: "Participants", text: "See every student who has joined the live class.", x: 87.2, y: 41, icon: Users },
  { id: "controls", label: "Camera & mic controls", text: "Control your camera, microphone and screen share.", x: 40, y: 95, icon: Video },
  { id: "record", label: "Record & YouTube Live", text: "Record the class or go live to your YouTube channel.", x: 57.5, y: 4.5, icon: Radio },
  { id: "register", label: "Class register", text: "Open the register for the class in the session.", x: 95.2, y: 16.4, icon: ClipboardList },
  { id: "attendance", label: "Attendance", text: "Mark and review who attended.", x: 95.2, y: 23.1, icon: ClipboardCheck },
  { id: "chat", label: "Chat", text: "Message the class without interrupting the lesson.", x: 95.2, y: 29.8, icon: MessageSquare },
  { id: "breakout", label: "Breakout rooms", text: "Split the class into smaller rooms.", x: 95.2, y: 36.4, icon: UsersRound },
  { id: "tools", label: "Lecture tools", text: "Notes, assignments and quizzes for this lecture.", x: 95.2, y: 50.9, icon: BookOpen },
  { id: "whiteboard", label: "Whiteboard", text: "Open a live whiteboard for the lecture.", x: 95.2, y: 64, icon: PenTool },
  { id: "settings", label: "Settings", text: "Choose video quality up to 1080p and turn on noise suppression.", x: 95.2, y: 93.8, icon: Cog },
];

const TABS: PanelTab[] = [
  {
    id: "register",
    label: "Class register",
    icon: ClipboardList,
    image: "classroom-register",
    mobile: true,
    title: "The register is inside the class",
    text: "Open the class register while you teach, without leaving the session.",
  },
  {
    id: "attendance",
    label: "Attendance",
    icon: ClipboardCheck,
    image: "classroom-attendance",
    title: "Attendance without the paperwork",
    text: "See who is present and keep the record with the session.",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    image: "classroom-chat",
    mobile: true,
    title: "Class chat, right beside the lesson",
    text: "Students can ask questions in chat while you keep teaching.",
  },
  {
    id: "notes",
    label: "Notes",
    icon: NotebookPen,
    image: "classroom-notes",
    title: "Notes for the lecture",
    text: "Open the lecture's notes from inside the classroom.",
  },
  {
    id: "assignments",
    label: "Assignments",
    icon: ListChecks,
    image: "classroom-assignments",
    title: "Assignments from the live class",
    text: "Give and follow assignments for the lecture you are teaching.",
  },
  {
    id: "quiz",
    label: "Quizzes",
    icon: HelpCircle,
    image: "classroom-quiz",
    title: "Quizzes for the lecture",
    text: "Reach the lecture's quizzes without leaving the classroom.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Cog,
    image: "classroom-settings",
    title: "Video quality you control",
    text: "Pick a video quality up to 1080p and switch on noise suppression.",
  },
  {
    id: "golive",
    label: "Record & Live",
    icon: Radio,
    image: "classroom-golive",
    title: "Record, or go live on YouTube",
    text: "Start a recording, or go live on your YouTube channel as Public, Unlisted or Private.",
  },
];

export default function LiveClassroom() {
  return (
    <section id="live" className="scroll-mt-20 bg-[#0B1120] py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            tone="dark"
            eyebrow="Live classroom"
            title="Teach Live, With Everything Within Reach"
            lead="Video, screen sharing, whiteboard, breakout rooms, chat, attendance and lecture tools, all inside the class itself."
          />
        </Reveal>

        <Reveal className="mt-12">
          <HotspotFigure
            image="classroom-main"
            alt="The SL Classroom live class: teacher stage, participants, camera controls and the classroom sidebar"
            pins={PINS}
          />
        </Reveal>

        <Reveal className="mt-16 sm:mt-20">
          <p className="mb-6 text-center text-sm font-semibold uppercase tracking-wider text-teal-300">Look inside the classroom</p>
          <PanelTabs dark tabs={TABS} frameTitle="SL Classroom · Live class" />
        </Reveal>
      </Container>
    </section>
  );
}
