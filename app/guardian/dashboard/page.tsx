import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { GUARDIAN_AUTH_COOKIE_NAME, verifyGuardianToken } from "@/lib/guardian-auth";
import { GuardianPortal } from "@/components/guardian/GuardianPortal";
import { GuardianSignOutButton } from "@/components/guardian/GuardianSignOutButton";

export const dynamic = "force-dynamic";

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
    <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
            Guardian Portal
          </p>
          <h1 className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">
            Welcome, {session.name}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Follow each of your students&apos; classes, payments, attendance, papers,
            assignments and quiz results.
          </p>
        </div>

        <GuardianSignOutButton />
      </div>

      <GuardianPortal guardianName={session.name} />
    </main>
  );
}
