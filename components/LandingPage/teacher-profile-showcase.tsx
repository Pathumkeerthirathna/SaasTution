import {
  Award,
  BadgeCheck,
  BookOpen,
  Globe,
  GraduationCap,
  MapPin,
  Trophy,
} from "lucide-react";
import SectionHeading from "./section-heading";

const subjects = [
  { name: "Mathematics", levels: ["O/L", "A/L"] },
  { name: "Science", levels: ["Primary", "O/L"] },
];

const perks = [
  { icon: Globe, label: "Your own link", desc: "A personal address you can share anywhere." },
  { icon: BookOpen, label: "Subjects & levels", desc: "Show Primary, O/L and A/L for every subject." },
  { icon: GraduationCap, label: "Qualifications", desc: "Build trust with your academic background." },
  { icon: Trophy, label: "Achievements", desc: "Highlight awards with photos and results." },
];

export default function TeacherProfileShowcase() {
  return (
    <section id="profile" className="scroll-mt-16 bg-slate-50 py-12 sm:py-16">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-8 px-4 sm:px-6 lg:grid-cols-2 lg:gap-12 lg:px-8">
        <div>
          <SectionHeading
            align="left"
            eyebrow="Public Profile"
            title="Be found by students and parents"
            description="Every teacher gets a professional public page that presents who you are, what you teach and the results you deliver."
          />

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {perks.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold text-slate-900">{label}</h3>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-600">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Mock profile */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
          <div className="h-20 bg-gradient-to-r from-[#112D5C] to-teal-600 sm:h-24" />

          <div className="px-4 pb-5 sm:px-5">
            <div className="-mt-8 flex items-end gap-3">
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-4 border-white bg-teal-100 text-lg font-bold text-teal-700 shadow-sm">
                PK
              </span>

              <div className="min-w-0 pb-1">
                <h3 className="flex items-center gap-1.5 text-[15px] font-bold text-slate-900">
                  <span className="truncate">Mr. Pathum Kumara</span>
                  <BadgeCheck className="h-4 w-4 shrink-0 text-teal-600" />
                </h3>
                <p className="text-[12px] text-slate-500">Mathematics teacher · 8 yrs experience</p>
              </div>
            </div>

            <p className="mt-3 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11.5px] text-slate-600">
              <MapPin className="h-3 w-3" /> Colombo
              <span className="mx-1 text-slate-300">|</span>
              slclassroom.live/your-name
            </p>

            <div className="mt-4">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
                Subjects &amp; levels
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {subjects.map((subject) => (
                  <div key={subject.name} className="rounded-lg border border-slate-200 p-2.5">
                    <p className="text-[13px] font-semibold text-slate-900">{subject.name}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {subject.levels.map((level) => (
                        <span
                          key={level}
                          className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700"
                        >
                          {level}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2.5 rounded-lg border border-amber-100 bg-amber-50 p-2.5">
              <Award className="h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-[12.5px] text-slate-700">Best Mathematics Teacher Award · 2025</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
