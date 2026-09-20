import { ArrowRight, Globe, KeyRound, LayoutDashboard, Lock, MonitorSmartphone, ShieldCheck } from "lucide-react";

import Reveal from "./reveal";
import { CheckList, Container, SectionHead } from "./ui";

const FLOW = [
  { icon: Globe, label: "Public pages" },
  { icon: KeyRound, label: "Login / Register" },
  { icon: LayoutDashboard, label: "Role dashboards" },
  { icon: Lock, label: "Protected live classroom" },
];

export default function Security() {
  return (
    <section id="security" className="scroll-mt-20 bg-[#0B1120] py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            tone="dark"
            eyebrow="Security"
            title="Built With Protected Access"
            lead="Your classes and student information sit behind sign-in, with separate access for teachers, students and guardians."
          />
        </Reveal>

        <Reveal className="mt-10">
          <ol className="flex flex-col items-stretch justify-center gap-3 md:flex-row md:items-center">
            {FLOW.map(({ icon: Icon, label }, index) => (
              <li key={label} className="flex flex-col items-center gap-3 md:flex-row">
                <span className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[14px] font-semibold text-white md:w-auto">
                  <Icon className="h-4 w-4 text-teal-300" />
                  {label}
                </span>
                {index < FLOW.length - 1 ? <ArrowRight className="h-4 w-4 rotate-90 text-teal-400 md:rotate-0" /> : null}
              </li>
            ))}
          </ol>
        </Reveal>

        <Reveal className="mt-10">
          <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/[0.04] p-6">
            <div className="mb-4 flex items-center gap-2 text-white">
              <ShieldCheck className="h-5 w-5 text-teal-300" />
              <h3 className="text-lg font-bold">What that means</h3>
            </div>
            <CheckList
              tone="dark"
              cols={2}
              items={[
                "Sign-in required for dashboards and classrooms",
                "Separate teacher, student and guardian access",
                "Teachers approve students who join",
                "Teachers approve student devices",
              ]}
            />
            <p className="mt-4 flex items-center gap-2 text-[12.5px] text-slate-400">
              <MonitorSmartphone className="h-4 w-4" />
              Works in the browser on desktop, tablet and phone.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
