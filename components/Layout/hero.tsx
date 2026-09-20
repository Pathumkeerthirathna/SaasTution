import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Container, Eyebrow } from "../LandingPage/ui";

export default function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-teal-50/80 via-white to-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(20,184,166,0.13),transparent)]" />

      <Container className="relative pb-4 pt-10 sm:pb-6 sm:pt-16 lg:pb-6 lg:pt-20">
        <div className="mx-auto max-w-4xl text-center">
          <Eyebrow>SL Classroom · Learn • Teach • Collaborate</Eyebrow>

          <h1 className="mt-5 text-[34px] font-bold leading-[1.08] tracking-tight text-slate-900 sm:text-5xl lg:text-[60px]">
            Everything You Need to <span className="text-teal-600">Teach, Manage &amp; Grow</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-slate-600 sm:text-lg">
            SL Classroom brings live teaching, students, learning materials, attendance, assessments, fees and
            communication together in one platform.
          </p>

          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <Link
              href="/register"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-6 py-3.5 text-[15px] font-semibold text-white shadow-lg shadow-teal-600/25 transition hover:bg-teal-700"
            >
              Start Teaching
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-[15px] font-semibold text-slate-700 transition hover:border-teal-500 hover:text-teal-700"
            >
              Login
            </Link>
          </div>

          <p className="mt-4 text-[12.5px] text-slate-500">
            Students and guardians access SL Classroom through their existing accounts.
          </p>
        </div>
      </Container>
    </section>
  );
}
