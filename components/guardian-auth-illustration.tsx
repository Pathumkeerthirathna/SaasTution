import { CalendarCheck, GraduationCap, LineChart, Wallet } from "lucide-react";

const FEATURES = [
  { icon: LineChart, label: "See attendance & quiz trends" },
  { icon: CalendarCheck, label: "Follow class schedules" },
  { icon: Wallet, label: "Track payments & dues" },
  { icon: GraduationCap, label: "View papers, assignments & results" },
];

export function GuardianAuthIllustration() {
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 p-8 text-white">
      {/* soft background shapes */}
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/10" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-white/5" />

      <div className="relative">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
          <GraduationCap className="h-3.5 w-3.5" />
          SL Classroom · Guardian
        </span>

        <h2 className="mt-5 text-xl font-bold leading-snug">
          Stay close to every step of your student&apos;s progress.
        </h2>
        <p className="mt-2 text-[13px] leading-5 text-emerald-50/90">
          One place to follow classes, attendance, payments, papers, assignments
          and quiz results for each student linked to you.
        </p>
      </div>

      {/* central "progress" illustration */}
      <div className="relative my-6 flex justify-center">
        <svg
          viewBox="0 0 220 150"
          className="h-40 w-full max-w-[240px]"
          role="img"
          aria-label="Student progress illustration"
        >
          <rect x="18" y="14" width="184" height="112" rx="10" fill="#ffffff" opacity="0.95" />
          <rect x="18" y="14" width="184" height="22" rx="10" fill="#ecfdf5" />
          <circle cx="30" cy="25" r="3" fill="#34d399" />
          <circle cx="40" cy="25" r="3" fill="#a7f3d0" />
          <circle cx="50" cy="25" r="3" fill="#d1fae5" />
          {/* bar chart */}
          <rect x="34" y="82" width="16" height="30" rx="3" fill="#d1fae5" />
          <rect x="58" y="70" width="16" height="42" rx="3" fill="#6ee7b7" />
          <rect x="82" y="58" width="16" height="54" rx="3" fill="#34d399" />
          <rect x="106" y="46" width="16" height="66" rx="3" fill="#10b981" />
          {/* trend line */}
          <path
            d="M34 78 L66 66 L90 54 L122 40 L154 34"
            stroke="#0f766e"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="154" cy="34" r="4" fill="#0f766e" />
          {/* checklist */}
          <rect x="140" y="58" width="52" height="8" rx="4" fill="#e2e8f0" />
          <rect x="140" y="72" width="40" height="8" rx="4" fill="#e2e8f0" />
          <rect x="140" y="86" width="46" height="8" rx="4" fill="#e2e8f0" />
          {/* floating check badge */}
          <circle cx="196" cy="34" r="14" fill="#ffffff" />
          <path d="M190 34l4 4 8-9" stroke="#10b981" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <ul className="relative space-y-2.5">
        {FEATURES.map(({ icon: Icon, label }) => (
          <li key={label} className="flex items-center gap-2.5 text-[13px] font-medium">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-white/15">
              <Icon className="h-3.5 w-3.5" />
            </span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
