import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ReactNode } from "react";

import { StudentShell } from "@/components/student-portal/student-shell";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

  return (
    <StudentShell
      studentName={student.name}
      studentEmail={student.email}
      registrationNumber={student.registrationNumber}
    >
      {children}
    </StudentShell>
  );
}
