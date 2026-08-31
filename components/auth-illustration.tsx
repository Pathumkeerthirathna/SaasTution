import { CalendarCheck, GraduationCap, Radio, Wallet } from "lucide-react";

const FEATURES = [
  { icon: Radio, label: "Run live online classes" },
  { icon: CalendarCheck, label: "Track attendance automatically" },
  { icon: Wallet, label: "Collect & reconcile payments" },
  { icon: GraduationCap, label: "Share notes, papers & quizzes" },
];

export function AuthIllustration() {
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 p-8 text-white">
      {/* soft background shapes */}
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/10" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-white/5" />

      <div className="relative">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
          <GraduationCap className="h-3.5 w-3.5" />
          SL Classroom
        </span>

        <h2 className="mt-5 text-xl font-bold leading-snug">
          Teach, track and connect — all from one place.
        </h2>
        <p className="mt-2 text-[13px] leading-5 text-emerald-50/90">
          The workspace for tutors and small institutes to manage classes,
          students, live sessions and fees.
        </p>
      </div>

      {/* central "class screen" illustration */}
      <div className="relative my-6 flex justify-center">
        <svg
          viewBox="0 0 220 150"
          className="h-40 w-full max-w-[240px]"
          role="img"
          aria-label="Online classroom illustration"
        >
          <rect x="18" y="14" width="184" height="112" rx="10" fill="#ffffff" opacity="0.95" />
          <rect x="18" y="14" width="184" height="22" rx="10" fill="#ecfdf5" />
          <circle cx="30" cy="25" r="3" fill="#34d399" />
          <circle cx="40" cy="25" r="3" fill="#a7f3d0" />
          <circle cx="50" cy="25" r="3" fill="#d1fae5" />
          {/* video tiles */}
          <rect x="30" y="46" width="74" height="46" rx="6" fill="#d1fae5" />
          <circle cx="67" cy="66" r="11" fill="#10b981" />
          <path d="M63 60l10 6-10 6z" fill="#ffffff" />
          <rect x="116" y="46" width="34" height="20" rx="4" fill="#e2e8f0" />
          <rect x="156" y="46" width="34" height="20" rx="4" fill="#e2e8f0" />
          <rect x="116" y="72" width="34" height="20" rx="4" fill="#e2e8f0" />
          <rect x="156" y="72" width="34" height="20" rx="4" fill="#e2e8f0" />
          {/* progress bar */}
          <rect x="30" y="104" width="160" height="8" rx="4" fill="#e2e8f0" />
          <rect x="30" y="104" width="104" height="8" rx="4" fill="#10b981" />
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
