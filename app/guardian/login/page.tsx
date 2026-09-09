import { Suspense } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { UsersRound } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { GuardianAuthIllustration } from "@/components/guardian-auth-illustration";
import { GuardianLoginForm } from "@/components/guardian-login-form";
import { GUARDIAN_AUTH_COOKIE_NAME, verifyGuardianToken } from "@/lib/guardian-auth";

export const dynamic = "force-dynamic";

export default async function GuardianLoginPage() {
  const token = cookies().get(GUARDIAN_AUTH_COOKIE_NAME)?.value;

  if (token) {
    const session = await verifyGuardianToken(token);
    if (session?.role === "GUARDIAN") {
      redirect("/guardian/dashboard");
    }
  }

  return (
    <Suspense
      fallback={<div className="p-6 text-sm text-slate-500">Loading sign in...</div>}
    >
      <AuthShell
        title="Guardian sign in"
        subtitle="Follow your student's classes, attendance, payments, papers and results."
        footerText="Are you a teacher?"
        footerLinkHref="/login"
        footerLinkLabel="Teacher sign in"
        icon={<UsersRound className="h-5 w-5" />}
        illustration={<GuardianAuthIllustration />}
        extraFooter={
          <>
            Are you a student?{" "}
            <Link
              href="/login"
              className="font-semibold text-emerald-700 hover:text-emerald-800"
            >
              Student sign in
            </Link>
          </>
        }
        showBackToHome
      >
        <GuardianLoginForm />
      </AuthShell>
    </Suspense>
  );
}
