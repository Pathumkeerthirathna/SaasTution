import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PasswordChangeForm } from "@/components/account/password-change-form";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { checkStudentSessionAccess } from "@/lib/student-session";

export const dynamic = "force-dynamic";

/**
 * Shared "Change your password" page (teachers, admins, students). The role
 * from the verified session decides the back link and the client checks;
 * students are also checked centrally (exists, active, session version) and
 * sent to /login otherwise. The API decides everything again.
 */
export default async function AccountSecurityPage() {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;
  const session = token ? await verifyAuthToken(token) : null;
  if (!session) redirect("/login");

  if (session.role === "STUDENT" && (await checkStudentSessionAccess(session)) !== "ACTIVE") {
    redirect("/login");
  }

  return <PasswordChangeForm role={session.role} />;
}
