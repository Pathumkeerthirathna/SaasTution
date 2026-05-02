import Link from "next/link";

import { GuardianRegisterForm } from "@/components/guardian-register-form";

export default function GuardianRegisterPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-10 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Guardian Portal</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Register guardian account</h1>
        <p className="mt-2 text-sm text-muted sm:text-base">
          Use the guardian ID and phone number provided by teacher to complete account setup.
        </p>

        <GuardianRegisterForm />

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/guardian/login" className="text-sm font-medium underline-offset-4 hover:underline">
            Already registered? Sign in
          </Link>
          <Link href="/" className="text-sm font-medium underline-offset-4 hover:underline">
            Back to home
          </Link>
        </div>
      </section>
    </main>
  );
}
