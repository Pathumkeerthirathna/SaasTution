import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ReactNode } from "react";

import { ClassAccessNotice } from "@/components/student-portal/class-access-notice";
import { StudentShell } from "@/components/student-portal/student-shell";
import { getClassAccessRestrictions } from "@/services/class-access-service";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { logError } from "@/lib/error-logging/server-logger";
import { prisma } from "@/lib/prisma";
import { checkStudentSessionAccess } from "@/lib/student-session";

type StudentLayoutProps = {
  children: ReactNode;
};

export default async function StudentLayout({ children }: StudentLayoutProps) {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const session = await verifyAuthToken(token);

  if (!session || session.role !== "STUDENT") {
    redirect("/login");
  }

  // Central student check (exists, active, session version); a database
  // failure throws (error page), it never renders the portal.
  if ((await checkStudentSessionAccess(session)) !== "ACTIVE") {
    redirect("/login");
  }

  const student = await prisma.student.findUnique({
    where: {
      id: session.sub,
    },
    select: {
      name: true,
      email: true,
      registrationNumber: true,
    },
  });

  if (!student) {
    redirect("/login");
  }

  // Payment-due access control: each restricted class is explained on every
  // page; the account and the payment pages stay available. The notice is
  // informational only (each protected route enforces the restriction
  // itself), so a failure here is logged and never blocks the portal.
  let restrictions: Awaited<ReturnType<typeof getClassAccessRestrictions>> = [];
  try {
    restrictions = await getClassAccessRestrictions(session.sub);
  } catch (error) {
    logError(error, { source: "server", kind: "class-access-notice", route: "/student", method: "GET" });
  }

  return (
    <StudentShell
      studentName={student.name}
      studentEmail={student.email}
      registrationNumber={student.registrationNumber}
    >
      <ClassAccessNotice restrictions={restrictions} />
      {children}
    </StudentShell>
  );
}
