import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function CTA() {
  return (
    <section className="bg-white px-4 pb-12 sm:px-6 sm:pb-16 lg:px-8">
      <div className="mx-auto w-full max-w-6xl overflow-hidden rounded-2xl bg-[#112D5C] px-5 py-10 text-center text-white sm:px-10 sm:py-12">
        <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Start managing your classes today
        </h2>

        <p className="mx-auto mt-3 max-w-md text-sm text-white/75 sm:text-[15px]">
          No setup needed. Start in minutes.
        </p>

        <div className="mt-6 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
          <Link
            href="/register"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 sm:w-auto"
          >
            Get Started Free
            <ArrowRight className="h-4 w-4" />
          </Link>

          <Link
            href="/login"
            className="inline-flex w-full items-center justify-center rounded-lg border border-white/30 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto"
          >
            Teacher Login
          </Link>
        </div>
      </div>
    </section>
  );
}
