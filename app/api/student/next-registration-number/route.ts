import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeacherSession } from "@/lib/auth-session";
import { generateStudentRegistrationNumber } from "@/services/student-service";

export async function GET() {
  const session = await requireTeacherSession();

  const teacher = await prisma.teacher.findUnique({
    where: {
      id: session.teacherId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  const registrationNumber =
    await generateStudentRegistrationNumber(
      teacher?.name ?? "Unknown"
    );

  return NextResponse.json({
    registrationNumber,
  });
}