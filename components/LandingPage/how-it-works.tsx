import { BookOpen, Radio, UserPlus, Users } from "lucide-react";
import SectionHeading from "./section-heading";

const steps = [
  { icon: UserPlus, title: "Create account", desc: "Sign up as a teacher and set up your public profile." },
  { icon: BookOpen, title: "Add classes", desc: "Create classes with schedules, fees and lectures." },
  { icon: Users, title: "Enrol students", desc: "Add students and invite parents to follow along." },
  { icon: Radio, title: "Start teaching", desc: "Go live, track attendance and manage everything easily." },
];

export default function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-16 bg-white py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How It Works"
          title="Up and running in four simple steps"
        />

        <ol className="mt-8 grid grid-cols-1 gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {steps.map(({ icon: Icon, title, desc }, index) => (
            <li key={title} className="relative rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span className="text-[22px] font-bold text-slate-200">0{index + 1}</span>
              </div>

              <h3 className="mt-3 text-[14.5px] font-semibold text-slate-900">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{desc}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
