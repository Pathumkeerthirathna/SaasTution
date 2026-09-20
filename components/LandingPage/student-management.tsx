import { CheckCircle2, FileSpreadsheet, ShieldCheck, UserPlus } from "lucide-react";

import Reveal from "./reveal";
import Shot from "./shot";
import { CheckList, Container, Frame, SectionHead } from "./ui";

const HIGHLIGHTS = [
  { icon: UserPlus, title: "Add students", text: "One at a time, or upload a student list." },
  { icon: CheckCircle2, title: "Approve joins", text: "Confirm or decline pending students, or confirm all at once." },
  { icon: FileSpreadsheet, title: "Import & export", text: "Download a template, upload your list, export to Excel." },
  { icon: ShieldCheck, title: "Stay in control", text: "Activate or deactivate students and approve devices." },
];

export default function StudentManagement() {
  return (
    <section id="students" className="scroll-mt-20 bg-white py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="Student management"
            title="Know Every Student in Your Classes"
            lead="Add, approve and organise students by class, and keep the whole roster in one place."
          />
        </Reveal>

        <div className="mt-12 grid items-center gap-8 lg:grid-cols-[1.35fr_1fr] lg:gap-12">
          <Reveal>
            <Frame title="SL Classroom · Students">
              <Shot name="dash-students" scrollOnMobile alt="The students panel with pending approvals, class filters and import options" />
            </Frame>
          </Reveal>
          <Reveal delay={120}>
            <ul className="space-y-4">
              {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-3.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-[15px] font-bold text-slate-900">{title}</span>
                    <span className="block text-[14px] leading-snug text-slate-600">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <CheckList items={["Students belong to your classes", "Their attendance, marks and fees follow them"]} />
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
