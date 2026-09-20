import { BarChart3, CalendarCheck, UserRound } from "lucide-react";
import SectionHeading from "./section-heading";

const items = [
  {
    icon: CalendarCheck,
    title: "Attendance Reports",
    desc: "Parents can track daily attendance easily",
    tone: "bg-emerald-50 text-emerald-600",
  },
  {
    icon: BarChart3,
    title: "Performance Insights",
    desc: "View quiz results and academic progress",
    tone: "bg-violet-50 text-violet-600",
  },
  {
    icon: UserRound,
    title: "Student Profile",
    desc: "Full view of student activity and growth",
    tone: "bg-sky-50 text-sky-600",
  },
];

export default function Parents() {
  return (
    <section id="parents" className="scroll-mt-16 bg-white py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="For Parents"
          title="Keep parents informed and engaged"
          description="Give parents access to their child’s attendance, performance and progress — building trust and transparency."
        />

        <div className="mt-8 grid grid-cols-1 gap-3 sm:mt-10 sm:grid-cols-3 sm:gap-4">
          {items.map(({ icon: Icon, title, desc, tone }) => (
            <div key={title} className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm sm:p-5">
              <span className={`mx-auto flex h-10 w-10 items-center justify-center rounded-xl ${tone}`}>
                <Icon className="h-5 w-5" />
              </span>
              <h3 className="mt-3 text-[14.5px] font-semibold text-slate-900">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
