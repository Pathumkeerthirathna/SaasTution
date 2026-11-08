import { reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { accessErrorResponse, requireTeacherOwnedStudent } from "@/lib/teacher-student-access";

export const dynamic = "force-dynamic";

// Teacher-only (/dashboard/students/[id]): the signed-in teacher's own student
// (401 without a teacher session, 404 for an unknown or another teacher's student).
// Never returns the password hash (explicit field list) and logs nothing.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;
    const { studentId } = await requireTeacherOwnedStudent(StudentId);

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        name: true,
        teacherId: true,
        createdAt: true,
        contact: true,
        registrationNumber: true,
        status: true,
        actionTakenDate: true,
        deactivationReason: true,
        gradeId: true,
        contact01: true,
        contact02: true,
        email: true,
        publicClassId: true,
        registrationSource: true,
        confirmationStatus: true,
        confirmedAt: true,
        confirmedById: true,
        approvedAt: true,
        emailConfirmed: true,
        emailConfirmedAt: true,
        registeredAt: true,
      },
    });

    if (!student) {
      return NextResponse.json(
        {
          success: false,
          message: "Student not found",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: student,
    });
  } catch (error) {
    // Access refusals keep their status (401 / 404); only unexpected errors
    // are reported and answered with 500, as before.
    const refused = accessErrorResponse(error);

    if (refused) {
      return refused;
    }

    reportRouteError(error, { request });

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load student",
      },
      { status: 500 }
    );
  }
}
