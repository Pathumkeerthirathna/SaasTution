import { NextRequest, NextResponse } from "next/server";
import { checkIfRegNoExists } from "@/services/student-service";
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

// Teachers only; the check itself spans every teacher's students.
await requireTeacherSession();

const studentId = searchParams.get("studentId") || undefined;

const result = await checkIfRegNoExists(
  registrationNumber,
  studentId
);

  return NextResponse.json(result);
}