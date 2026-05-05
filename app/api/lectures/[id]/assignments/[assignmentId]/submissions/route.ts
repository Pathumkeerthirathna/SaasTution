import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/lectures/[id]/assignments/[assignmentId]/submissions
// Returns all student submissions for a teacher's assignment.
export async function GET(
  _request: Request,
  context: { params: { id: string; assignmentId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { id: lectureId, assignmentId } = context.params;

    if (!lectureId?.trim() || !assignmentId?.trim()) {
      throw new AppError("Lecture id and assignment id are required.", 400, "VALIDATION_ERROR");
    }

    // Verify the assignment belongs to a lecture owned by this teacher.
    const assignment = await prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        lectureId,
        lecture: {
          class: {
            teacherId: session.teacherId,
          },
        },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        lecture: {
          select: {
            class: {
              select: {
                students: {
                  select: { studentId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!assignment) {
      throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
    }

    const enrolledStudentIds = new Set(
      assignment.lecture.class.students.map((s) => s.studentId)
    );
    const totalEnrolled = enrolledStudentIds.size;

    const submissions = await prisma.assignmentSubmission.findMany({
      where: { assignmentId },
      select: {
        id: true,
        fileName: true,
        sizeBytes: true,
        notes: true,
        submittedAt: true,
        student: {
          select: {
            id: true,
            name: true,
            registrationNumber: true,
          },
        },
      },
      orderBy: { submittedAt: "asc" },
    });

    const submissionRows = submissions.map((sub) => ({
      submissionId: sub.id,
      studentId: sub.student.id,
      studentName: sub.student.name,
      registrationNumber: sub.student.registrationNumber ?? null,
      fileName: sub.fileName,
      sizeBytes: sub.sizeBytes,
      notes: sub.notes ?? null,
      submittedAt: sub.submittedAt,
    }));

    return apiSuccess({
      assignment: {
        id: assignment.id,
        title: assignment.title,
        dueDate: assignment.dueDate,
        totalEnrolled,
      },
      totalSubmissions: submissions.length,
      submissions: submissionRows,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
