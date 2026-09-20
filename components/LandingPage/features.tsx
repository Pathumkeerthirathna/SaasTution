import {
  BarChart3,
  BookOpen,
  CalendarCheck,
  CalendarDays,
  ClipboardCheck,
  FolderOpen,
  Globe,
  MessageSquare,
  Radio,
  ShieldCheck,
  UserCheck,
  Video,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import SectionHeading from "./section-heading";

interface Feature {
  icon: LucideIcon;
  title: string;
  desc: string;
  tone: string;
}

const features: Feature[] = [
  {
    icon: Video,
    title: "Live Classes",
    desc: "Teach in the browser with screen sharing, chat and adjustable video quality up to 1080p.",
    tone: "bg-teal-50 text-teal-600",
  },
  {
    icon: Radio,
    title: "Recording & Streaming",
    desc: "Record every session and stream live to YouTube so students can rewatch anytime.",
    tone: "bg-rose-50 text-rose-600",
  },
  {
    icon: BookOpen,
    title: "Class Management",
    desc: "Organise classes, schedules and lectures, and enrol students in a few clicks.",
    tone: "bg-sky-50 text-sky-600",
  },
  {
    icon: CalendarCheck,
    title: "Attendance Tracking",
    desc: "Attendance is captured automatically when students join, with clear reports.",
    tone: "bg-emerald-50 text-emerald-600",
  },
  {
    icon: ClipboardCheck,
    title: "Quizzes & Assignments",
    desc: "Run quizzes live or after class and collect assignments with instant results.",
    tone: "bg-violet-50 text-violet-600",
  },
  {
    icon: FolderOpen,
    title: "Notes, Tutes & Papers",
    desc: "Share lecture notes, tutorials and past papers, organised into material bundles.",
    tone: "bg-amber-50 text-amber-600",
  },
  {
    icon: Wallet,
    title: "Payments & Fees",
    desc: "Track monthly fees, review payment slips and see who has paid at a glance.",
    tone: "bg-orange-50 text-orange-600",
  },
  {
    icon: MessageSquare,
    title: "Messaging",
    desc: "Send class updates and reminders to students and parents by email or WhatsApp.",
    tone: "bg-indigo-50 text-indigo-600",
  },
  {
    icon: CalendarDays,
    title: "Teaching Calendar",
    desc: "See classes, lectures, quizzes and events together in one clear calendar.",
    tone: "bg-cyan-50 text-cyan-600",
  },
  {
    icon: UserCheck,
    title: "Parent Access",
    desc: "Parents follow attendance and progress with their own secure login.",
    tone: "bg-pink-50 text-pink-600",
  },
  {
    icon: BarChart3,
    title: "Student Insights",
    desc: "Spot improving and at-risk students early from quiz and attendance trends.",
    tone: "bg-lime-50 text-lime-700",
  },
  {
    icon: ShieldCheck,
    title: "Device Approval",
    desc: "Approve the devices students use so accounts cannot be shared.",
    tone: "bg-slate-100 text-slate-600",
  },
  {
    icon: Globe,
    title: "Public Teacher Profile",
    desc: "Get your own page with subjects, levels, qualifications and achievements.",
    tone: "bg-teal-50 text-teal-600",
  },
];

export default function Features() {
  return (
    <section id="features" className="scroll-mt-16 bg-slate-50 py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Features"
          title="Everything a teacher needs in one place"
          description="From the first lecture to the final fee reminder, manage your whole teaching business without juggling tools."
        />

        <div className="mt-8 grid grid-cols-1 gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, desc, tone }) => (
            <div
              key={title}
              className="flex gap-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-200 hover:shadow-md"
            >
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
                <Icon className="h-[18px] w-[18px]" />
              </span>

              <div className="min-w-0">
                <h3 className="text-[14.5px] font-semibold text-slate-900">{title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
