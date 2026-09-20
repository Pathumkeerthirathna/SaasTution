import {
  CheckCircle2,
  Mic,
  MessageCircle,
  Monitor,
  Radio,
  UserCheck,
  Video,
} from "lucide-react";
import SectionHeading from "./section-heading";

const points = [
  "Start a class in one click — no software to install",
  "Screen sharing, chat and noise suppression built in",
  "Choose 1080p, 720p or 480p to match your connection",
  "Automatic attendance and session recording",
  "Live-stream to YouTube for students who cannot join",
];

const controls = [
  { icon: Mic, label: "Mic" },
  { icon: Video, label: "Camera" },
  { icon: Monitor, label: "Share" },
  { icon: MessageCircle, label: "Chat" },
  { icon: Radio, label: "Stream" },
];

const students = ["Nimal P.", "Kavindu S.", "Sanduni R.", "Tharushi W."];

export default function LiveClassroom() {
  return (
    <section id="live" className="scroll-mt-16 bg-white py-12 sm:py-16">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-8 px-4 sm:px-6 lg:grid-cols-2 lg:gap-12 lg:px-8">
        {/* Mock classroom */}
        <div className="order-2 overflow-hidden rounded-2xl border border-slate-200 bg-[#112D5C] shadow-lg lg:order-1">
          <div className="flex items-center justify-between px-4 py-2.5 text-white">
            <span className="text-[12px] font-semibold">Grade 11 Mathematics</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
              <span className="h-1.5 w-1.5 rounded-full bg-white" /> Live
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 px-3 pb-3">
            <div className="col-span-3 flex aspect-video items-center justify-center rounded-xl bg-white/10 sm:col-span-2">
              <div className="text-center text-white/80">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-white/15">
                  <Video className="h-5 w-5" />
                </span>
                <p className="mt-2 text-[12px]">Teacher camera &amp; screen</p>
              </div>
            </div>

            <div className="col-span-3 grid grid-cols-4 gap-2 sm:col-span-1 sm:grid-cols-1">
              {students.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-1.5 text-[11px] text-white/90"
                >
                  <UserCheck className="h-3 w-3 shrink-0 text-emerald-300" />
                  <span className="truncate">{name}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 border-t border-white/10 bg-black/20 px-3 py-3">
            {controls.map(({ icon: Icon, label }) => (
              <span
                key={label}
                title={label}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
              >
                <Icon className="h-4 w-4" />
                <span className="sr-only">{label}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="order-1 lg:order-2">
          <SectionHeading
            align="left"
            eyebrow="Live Classroom"
            title="A classroom that works as hard as you do"
            description="Everything you need to teach live is inside one screen, so you can focus on the lesson instead of the tools."
          />

          <ul className="mt-5 space-y-2.5">
            {points.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-[13.5px] text-slate-700">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
