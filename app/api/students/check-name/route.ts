import { NextRequest, NextResponse } from "next/server";
import { checkIfNameExists } from "@/services/student-service";
import { requireTeacherSession } from "@/lib/auth-session";
import { parseGradeFilter } from "@/lib/grade";

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
  // Grade 0 is a real grade ("0" is checked within Grade 0, not ignored).
  const gradeId = parseGradeFilter(gradeIdParam);

  const teacher = await requireTeacherSession();

  const result = await checkIfNameExists(
    registrationNumber,
    studentId,
    teacher.teacherId,
    gradeId
  );

  return NextResponse.json(result);
}