import {
  ArrowDown,
  ArrowRight,
  BarChart3,
  BookOpen,
  ClipboardCheck,
  FileText,
  GraduationCap,
  LayoutDashboard,
  Radio,
  Send,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import Reveal from "./reveal";
import { Container, SectionHead } from "./ui";

/* -------------------------------- the four jobs -------------------------------- */

const GROUPS: { title: string; sub: string; icon: LucideIcon; tone: string; items: string[] }[] = [
  {
    title: "Teach",
    sub: "Live classes that do more",
    icon: Radio,
    tone: "from-teal-500 to-teal-600",
    items: ["Live classroom", "Screen sharing", "Whiteboard", "Breakout rooms", "Chat", "YouTube recording & Live"],
  },
  {
    title: "Manage",
    sub: "Your classes and students",
    icon: UsersRound,
    tone: "from-sky-500 to-blue-600",
    items: ["Classes & schedules", "Students & approvals", "Lectures & calendar", "Guardians", "Device approvals", "Public teacher profile"],
  },
  {
    title: "Engage",
    sub: "Learning after the live class",
    icon: BookOpen,
    tone: "from-violet-500 to-indigo-600",
    items: ["Notes & materials", "Assignments", "Online quizzes", "Timed papers", "Tutes & Papers", "Announcements"],
  },
  {
    title: "Track",
    sub: "Know how every class is going",
    icon: BarChart3,
    tone: "from-amber-500 to-orange-600",
    items: ["Attendance & class register", "Submissions & marks", "Student analytics", "Fees & payment proof", "Session history", "Guardian view"],
  },
];

/* --------------------------------- the lifecycle -------------------------------- */

const PHASES: {
  title: string;
  icon: LucideIcon;
  steps: [number, string][];
  branches?: string[];
}[] = [
  {
    title: "Set up",
    icon: GraduationCap,
    steps: [[1, "Create your profile"], [2, "Create your class"], [3, "Add students"], [4, "Schedule lectures"]],
  },
  {
    title: "Teach live",
    icon: Radio,
    steps: [[5, "Invite students"], [6, "Start the live class"], [7, "Teach with the whiteboard"], [8, "Use breakout rooms"], [9, "Chat and take attendance"]],
    branches: ["Whiteboard", "Breakout rooms", "Chat", "Attendance"],
  },
  {
    title: "Give learning",
    icon: FileText,
    steps: [[10, "Share notes"], [11, "Give assignments"], [12, "Create quizzes"], [13, "Give papers"]],
    branches: ["Notes", "Assignments", "Quizzes", "Papers"],
  },
  {
    title: "Review & manage",
    icon: ClipboardCheck,
    steps: [[14, "Review submissions and marks"], [15, "Track fees and payments"], [16, "Message your students"]],
    branches: ["Marks", "Payments", "Communication"],
  },
  {
    title: "Control centre",
    icon: LayoutDashboard,
    steps: [[17, "Review the whole class from the dashboard"]],
  },
];

export default function PlatformOverview() {
  return (
    <section id="platform" className="scroll-mt-20 bg-white pb-16 pt-6 sm:pb-24 sm:pt-8">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="The complete platform"
            title="One platform for your whole teaching operation"
            lead="SL Classroom is not just video meetings. Classes, students, live teaching, learning materials, assessments, attendance and fees all live in one connected system."
          />
        </Reveal>

        {/* Hub */}
        <Reveal className="mt-12 sm:mt-14">
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-3 rounded-2xl bg-[#112D5C] px-5 py-3 text-white shadow-xl shadow-[#112D5C]/20">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-500">
                <GraduationCap className="h-5 w-5" />
              </span>
              <span className="leading-tight">
                <span className="block text-[15px] font-bold">SL Classroom</span>
                <span className="block text-[11px] text-slate-300">Learn • Teach • Collaborate</span>
              </span>
            </div>
            <span className="hidden h-7 w-px bg-teal-300 lg:block" />
          </div>

          <div className="relative mt-4 grid gap-4 sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
            <span className="absolute left-[12.5%] right-[12.5%] top-0 hidden h-px bg-teal-300 lg:block" />
            {GROUPS.map(({ title, sub, icon: Icon, tone, items }) => (
              <div
                key={title}
                className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg lg:mt-7 lg:before:absolute lg:before:-top-7 lg:before:left-1/2 lg:before:h-7 lg:before:w-px lg:before:bg-teal-300"
              >
                <div className="flex items-center gap-3">
                  <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${tone} text-white shadow-md`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-lg font-bold leading-tight text-slate-900">{title}</h3>
                    <p className="text-[13px] text-slate-500">{sub}</p>
                  </div>
                </div>
                <ul className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-1">
                  {items.map((item) => (
                    <li key={item} className="flex items-center gap-2 text-[13.5px] text-slate-700">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Lifecycle */}
        <Reveal className="mt-16 sm:mt-24">
          <div className="mx-auto max-w-3xl text-center">
            <h3 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Everything connects, from your first class to the full dashboard
            </h3>
            <p className="mt-3 text-[15px] text-slate-600 sm:text-base">
              Each step feeds the next: the classes you create, the students you add and the lectures you schedule carry
              straight into live sessions, attendance, learning, review, fees and your dashboard.
            </p>
          </div>

          <ol className="mt-10 flex flex-col items-stretch gap-2 lg:flex-row lg:gap-0">
            {PHASES.map((phase, index) => {
              const Icon = phase.icon;
              const last = index === PHASES.length - 1;

              return (
                <li key={phase.title} className="flex flex-col items-center lg:flex-1 lg:flex-row lg:items-stretch">
                  <div
                    className={`w-full rounded-2xl border p-4 shadow-sm lg:h-full ${
                      last ? "border-[#112D5C] bg-[#112D5C] text-white" : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${last ? "bg-teal-500 text-white" : "bg-teal-100 text-teal-700"}`}>
                        <Icon className="h-[18px] w-[18px]" />
                      </span>
                      <h4 className={`text-[15px] font-bold ${last ? "text-white" : "text-slate-900"}`}>{phase.title}</h4>
                    </div>
                    <ol className="mt-3 space-y-2">
                      {phase.steps.map(([n, label]) => (
                        <li key={n} className={`flex items-start gap-2 text-[13px] leading-snug ${last ? "text-slate-200" : "text-slate-700"}`}>
                          <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${last ? "bg-white/15 text-white" : "bg-white text-teal-700 ring-1 ring-teal-200"}`}>
                            {n}
                          </span>
                          {label}
                        </li>
                      ))}
                    </ol>
                    {phase.branches ? (
                      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-200 pt-3">
                        {phase.branches.map((b) => (
                          <span key={b} className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800 ring-1 ring-teal-100">
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {!last ? (
                    <span className="flex h-8 items-center justify-center text-teal-500 lg:h-auto lg:w-8 lg:shrink-0">
                      <ArrowDown className="h-5 w-5 lg:hidden" />
                      <ArrowRight className="hidden h-5 w-5 lg:block" />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <p className="mt-6 flex items-center justify-center gap-2 text-center text-[13px] text-slate-500">
            <Wallet className="h-4 w-4 text-teal-600" />
            <Send className="h-4 w-4 text-teal-600" />
            Fees, payment proof and student communication are part of the same connected flow.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
