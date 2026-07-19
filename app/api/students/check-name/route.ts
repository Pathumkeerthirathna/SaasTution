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

const teacher = await requireTeacherSession();

const studentId = searchParams.get("studentId") ?? undefined;

const result = await checkIfNameExists(
  registrationNumber,
  studentId,
  teacher.teacherId
);

  return NextResponse.json(result);
}