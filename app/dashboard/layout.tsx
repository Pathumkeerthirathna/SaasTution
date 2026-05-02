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

  const teacher = await prisma.teacher.findUnique({
    where: {
      id: session.sub,
    },
    select: {
      name: true,
      email: true,
    },
  });

  if (!teacher) {
    redirect("/login");
  }

  return (
    <DashboardShell role="TEACHER" name={teacher.name} email={teacher.email}>
      {children}
    </DashboardShell>
  );
}
