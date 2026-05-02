import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { GUARDIAN_AUTH_COOKIE_NAME, verifyGuardianToken } from "@/lib/guardian-auth";
import { GuardianStudentPanel } from "@/components/guardian-student-panel";

export default async function GuardianDashboardPage() {
  const token = cookies().get(GUARDIAN_AUTH_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/guardian/login");
  }

  const session = await verifyGuardianToken(token);

  if (!session || session.role !== "GUARDIAN") {
    redirect("/guardian/login");
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Guardian Dashboard</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Welcome, {session.name}</h1>
        <p className="mt-2 text-sm text-muted sm:text-base">
          Access your student profile, contact details, and class schedule.
        </p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/guardian/login"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Switch account
          </Link>
          <Link
            href="/"
            className="inline-flex rounded-xl border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            Back to home
          </Link>
        </div>
      </section>

      <GuardianStudentPanel />
    </main>
  );
}
