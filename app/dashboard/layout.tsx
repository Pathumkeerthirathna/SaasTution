import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ReactNode } from "react";

import { DashboardShell } from "@/components/dashboard-shell";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type DashboardLayoutProps = {
  children: ReactNode;
};

export default async function DashboardLayout({ children }: DashboardLayoutProps) {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const session = await verifyAuthToken(token);


  console.log("Session in DashboardLayout:", session);

  if (!session) {
    redirect("/login");
  }

  if (session.role === "ADMIN") {
    return (
      <DashboardShell role="ADMIN" name={session.name} email={session.email}>
        {children}
      </DashboardShell>
    );
  }

  if (session.role === "STUDENT") {
    redirect("/student/dashboard");
  }

  const teacher = await prisma.teacher.findUnique({
    where: {
      id: session.sub,
    },
    select: {
      name: true,
      email: true,
      isConfirmed: true,
      isRejected: true,
    },
  });

  if (!teacher) {
    redirect("/login");
  }

  const isPending = !teacher.isConfirmed && !teacher.isRejected;

  return (
    <DashboardShell
      role="TEACHER"
      name={teacher.name}
      email={teacher.email}
      isPending={isPending}
    >
      {children}
    </DashboardShell>
  );
}
