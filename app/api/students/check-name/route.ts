import { NextRequest, NextResponse } from "next/server";
import { checkIfNameExists } from "@/services/student-service";
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

  const gradeIdParam = searchParams.get("gradeId");
  const gradeId =
    gradeIdParam && Number.isFinite(Number(gradeIdParam))
      ? Number(gradeIdParam)
      : undefined;

  // Optional teacherId
  let teacherId = searchParams.get("teacherId");

  if (!teacherId) {
    const teacher = await requireTeacherSession();
    teacherId = teacher.teacherId;
  }

  const result = await checkIfNameExists(
    registrationNumber,
    studentId,
    teacherId,
    gradeId
  );

  return NextResponse.json(result);
}