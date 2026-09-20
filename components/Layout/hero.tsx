import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  Video,
  Wallet,
} from "lucide-react";
import DashboardPreview from "../LandingPage/dashboard-preview";

const highlights = [
  { icon: Video, label: "Live classes" },
  { icon: CalendarCheck, label: "Auto attendance" },
  { icon: ClipboardCheck, label: "Quizzes & papers" },
  { icon: Wallet, label: "Fee tracking" },
];

export default function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-teal-50/70 via-white to-white">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-2 lg:gap-12 lg:px-8 lg:py-20">
        <div className="text-center lg:text-left">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-100 bg-white px-3 py-1 text-[11.5px] font-semibold text-teal-700 shadow-sm">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Built for tuition teachers in Sri Lanka
          </span>

          <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl lg:text-[44px]">
            Run your classes online,{" "}
            <span className="text-emerald-600">the smart way</span>
          </h1>

          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-slate-600 sm:text-base lg:mx-0">
            Conduct live classes, run quizzes, monitor attendance and payments,
            and give parents real-time visibility — all in one platform.
          </p>

          <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:justify-center lg:justify-start">
            <Link
              href="/register"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              Start Free Trial
              <ArrowRight className="h-4 w-4" />
            </Link>

            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-emerald-500 hover:text-emerald-600"
            >
              Teacher Login
            </Link>
          </div>

          <ul className="mt-7 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:max-w-lg">
            {highlights.map(({ icon: Icon, label }) => (
              <li
                key={label}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[12px] font-medium text-slate-700 shadow-sm lg:justify-start"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        <DashboardPreview />
      </div>
    </section>
  );
}
