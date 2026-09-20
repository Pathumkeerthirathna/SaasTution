import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  FileText,
  GraduationCap,
  MessageSquare,
  Radio,
  UsersRound,
  Wallet,
  Award,
} from "lucide-react";

import DashboardIllustration from "./dashboard-illustration";
import Reveal from "./reveal";
import Shot from "./shot";
import { Container, Frame, SectionHead } from "./ui";

const MODULES = [
  { icon: BookOpen, label: "Classes" },
  { icon: UsersRound, label: "Students" },
  { icon: GraduationCap, label: "Lectures" },
  { icon: Radio, label: "Live sessions" },
  { icon: ClipboardCheck, label: "Attendance" },
  { icon: FileText, label: "Learning materials" },
  { icon: Award, label: "Assessments" },
  { icon: Wallet, label: "Payments" },
  { icon: MessageSquare, label: "Communication" },
  { icon: CalendarDays, label: "Calendar" },
];

export default function ControlCenter() {
  return (
    <section id="dashboard" className="scroll-mt-20 bg-slate-50 py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="Teacher dashboard"
            title="Run Your Entire Classroom From One Place"
            lead="Your dashboard is the control centre: live classes in progress, pending approvals, work to review and fees to follow up, all in one view."
          />
        </Reveal>

        <div className="mt-12 grid items-start gap-8 lg:grid-cols-[1.2fr_1fr] lg:gap-10">
          <Reveal>
            <DashboardIllustration />
          </Reveal>

          <Reveal delay={120} className="space-y-6">
            <div>
              <h3 className="text-xl font-bold text-slate-900">Every part of your teaching, connected</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
                Classes hold students. Students attend lectures. Lectures run as live sessions and carry their own
                notes, assignments, quizzes and whiteboards. Attendance, marks and fees follow automatically.
              </p>
              <ul className="mt-5 grid grid-cols-2 gap-2.5">
                {MODULES.map(({ icon: Icon, label }) => (
                  <li key={label} className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[13.5px] font-medium text-slate-800 shadow-sm">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                      <Icon className="h-4 w-4" />
                    </span>
                    {label}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <Frame title="Lectures">
                <Shot name="dash-lectures" scrollOnMobile alt="The lecture manager: each lecture shows its notes, assignments, quizzes and whiteboards" />
              </Frame>
              <p className="mt-2.5 text-[13px] text-slate-500">
                Every lecture keeps its notes, assignments, quizzes and whiteboards together, with sessions, recordings
                and live streams one click away.
              </p>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
