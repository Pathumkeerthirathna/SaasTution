"use client";

import { ArrowRight, BookOpen, FileText, GraduationCap, HelpCircle, ListChecks, ScrollText, Send, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import PanelTabs, { type PanelTab } from "./panel-tabs";
import Reveal from "./reveal";
import { CheckList, Container, SectionHead } from "./ui";

const PIPELINE: { label: string; icon: LucideIcon }[] = [
  { label: "Lecture", icon: GraduationCap },
  { label: "Notes", icon: BookOpen },
  { label: "Assignments", icon: ListChecks },
  { label: "Quizzes", icon: HelpCircle },
  { label: "Papers", icon: ScrollText },
  { label: "Submissions", icon: Send },
  { label: "Marks", icon: Star },
];

const TABS: PanelTab[] = [
  {
    id: "lectures",
    label: "Lectures",
    icon: GraduationCap,
    image: "dash-lectures",
    title: "Everything for a lecture, in one place",
    text: "Each lecture keeps its notes, assignments, quizzes and whiteboards together.",
    points: ["Recordings and live streams alongside", "Session history for every lecture"],
  },
  {
    id: "notes",
    label: "Notes",
    icon: BookOpen,
    image: "classroom-notes",
    title: "Share notes and materials",
    text: "Attach notes to a lecture so students have them when they need them.",
  },
  {
    id: "assignments",
    label: "Assignments",
    icon: ListChecks,
    image: "classroom-assignments",
    title: "Give assignments and review submissions",
    text: "Set an assignment for a lecture, then review what students submit.",
  },
  {
    id: "quizzes",
    label: "Quizzes",
    icon: HelpCircle,
    image: "classroom-quiz",
    title: "Online quizzes for a lecture",
    text: "Create quizzes students complete online and see the results afterwards.",
  },
];

export default function AfterClass() {
  return (
    <section id="after-class" className="scroll-mt-20 bg-slate-50 py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="Learning materials & assessments"
            title="Everything After the Live Class"
            lead="Learning does not stop when the session ends. Notes, assignments, quizzes and papers stay connected to the lecture."
          />
        </Reveal>

        <Reveal className="mt-10">
          <ol className="flex flex-wrap items-center justify-center gap-y-2">
            {PIPELINE.map(({ label, icon: Icon }, index) => (
              <li key={label} className="flex items-center">
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-800 shadow-sm">
                  <Icon className="h-4 w-4 text-teal-600" />
                  {label}
                </span>
                {index < PIPELINE.length - 1 ? <ArrowRight className="mx-1.5 h-4 w-4 text-teal-400" /> : null}
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal className="mt-12">
          <PanelTabs tabs={TABS} frameTitle="SL Classroom · Learning tools" />
        </Reveal>

        <Reveal className="mt-14">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
                <HelpCircle className="h-5 w-5" />
              </span>
              <h3 className="mt-3 text-lg font-bold text-slate-900">Quizzes</h3>
              <div className="mt-3">
                <CheckList items={["Students take quizzes online", "Results are collected for you", "Guardians can see quiz results"]} />
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                <FileText className="h-5 w-5" />
              </span>
              <h3 className="mt-3 text-lg font-bold text-slate-900">Papers</h3>
              <div className="mt-3">
                <CheckList items={["Give timed online papers", "Send Tutes & Papers to students", "Review submissions and marks"]} />
              </div>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
