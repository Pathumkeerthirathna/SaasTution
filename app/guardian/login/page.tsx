import Link from "next/link";

import { GuardianLoginForm } from "@/components/guardian-login-form";

export default function GuardianLoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-10 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Guardian Portal</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Guardian login</h1>
        <p className="mt-2 text-sm text-muted sm:text-base">
          Sign in to view your student profile and class information.
        </p>

        <GuardianLoginForm />

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/guardian/register" className="text-sm font-medium underline-offset-4 hover:underline">
            New guardian? Register account
          </Link>
          <Link href="/" className="text-sm font-medium underline-offset-4 hover:underline">
            Back to home
          </Link>
        </div>
      </section>
    </main>
  );
}
