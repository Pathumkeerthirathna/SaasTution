import Link from "next/link";
import { ArrowRight } from "lucide-react";

import Reveal from "./reveal";
import { Container } from "./ui";

export default function CTA() {
  return (
    <section className="bg-white py-16 sm:py-24">
      <Container>
        <Reveal>
          <div className="mx-auto max-w-4xl rounded-3xl bg-gradient-to-br from-[#112D5C] to-[#1c4a86] px-6 py-12 text-center text-white shadow-2xl sm:px-12 sm:py-16">
            <h2 className="text-[28px] font-bold leading-tight tracking-tight sm:text-4xl">Ready to run your classes in one place?</h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] text-slate-200 sm:text-lg">
              Set up your profile, create your first class and go live with your students.
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <Link
                href="/register"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-teal-500 px-6 py-3.5 text-[15px] font-semibold text-white shadow-lg transition hover:bg-teal-400"
              >
                Start Teaching
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-xl border border-white/30 px-6 py-3.5 text-[15px] font-semibold text-white transition hover:bg-white/10"
              >
                Login
              </Link>
            </div>
            <p className="mt-5 text-[12.5px] text-slate-300">
              Already have an account? Login. Students and guardians access SL Classroom through their existing accounts.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
