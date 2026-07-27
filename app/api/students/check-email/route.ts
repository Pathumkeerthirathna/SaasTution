import { NextRequest, NextResponse } from "next/server";
import { checkIfEmailExists } from "@/services/student-service";
import { requireTeacherSession } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const registrationNumber = searchParams.get("registrationNumber");

  if (!registrationNumber) {
    return NextResponse.json(
      { message: "Registration number is required" },
      { status: 400 }
    );
  }

  const studentId = searchParams.get("studentId") ?? undefined;

  // Optional teacherId
  let teacherId = searchParams.get("teacherId");

  if (!teacherId) {
    const teacher = await requireTeacherSession();
    teacherId = teacher.teacherId;
  }

  const result = await checkIfEmailExists(
    registrationNumber,
    studentId,
    teacherId
  );

  return NextResponse.json(result);
}