import { ArrowRight, GraduationCap, HeartHandshake, UserRound } from "lucide-react";
import Link from "next/link";

import Reveal from "./reveal";
import Shot from "./shot";
import StudentIllustration from "./student-illustration";
import { CheckList, Container, Frame, SectionHead } from "./ui";

function Node({ icon: Icon, label, tone }: { icon: typeof UserRound; label: string; tone: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-md ${tone}`}>
      <Icon className="h-4 w-4" />
      {label}
    </span>
  );
}

export default function StudentsGuardians() {
  return (
    <section id="families" className="scroll-mt-20 bg-white py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="Students & guardians"
            title="Everyone Stays in the Loop"
            lead="Students join class and keep up with their work. Guardians can follow progress, attendance and payments."
          />
        </Reveal>

        <Reveal className="mt-10">
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <Node icon={UserRound} label="Teacher" tone="bg-[#112D5C]" />
            <ArrowRight className="h-4 w-4 text-teal-500" />
            <Node icon={GraduationCap} label="Student" tone="bg-teal-600" />
            <ArrowRight className="h-4 w-4 rotate-180 text-teal-500" />
            <Node icon={HeartHandshake} label="Guardian" tone="bg-sky-600" />
          </div>
        </Reveal>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-2">
          <Reveal>
            <h3 className="mb-4 text-xl font-bold text-slate-900">For students</h3>
            <StudentIllustration />
            <div className="mt-5">
              <CheckList items={["Join live classes", "Countdowns for quizzes and papers", "Notes, assignments and payment status"]} />
            </div>
          </Reveal>
          <Reveal delay={120}>
            <h3 className="mb-4 text-xl font-bold text-slate-900">For guardians</h3>
            <Frame title="SL Classroom · Guardian portal">
              <Shot name="guardian-portal" scrollOnMobile alt="The guardian portal with attendance by month, quiz results and payment standing" />
            </Frame>
            <div className="mt-5">
              <CheckList items={["Attendance by month", "Quiz results over time", "Payments, papers and assignments"]} />
            </div>
          </Reveal>
        </div>

        <Reveal className="mt-10">
          <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center">
            <p className="text-[14px] text-slate-600">Students and guardians access SL Classroom through their existing accounts.</p>
            <p className="mt-2 text-[14px] font-semibold text-slate-800">
              Already have an account?{" "}
              <Link href="/login" className="text-teal-700 underline-offset-2 hover:underline">Student login</Link>
              {" · "}
              <Link href="/guardian/login" className="text-teal-700 underline-offset-2 hover:underline">Guardian login</Link>
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
