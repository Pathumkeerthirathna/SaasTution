import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { bundleId: string; itemId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId, itemId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim()) {
      throw new AppError("Bundle id and item id are required.", 400, "VALIDATION_ERROR");
    }

    const bundleItem = await prisma.materialBundleItem.findFirst({
      where: {
        id: itemId,
        bundleId,
        bundle: {
          class: {
            teacherId: session.teacherId,
          },
        },
      },
      select: {
        id: true,
        type: true,
        title: true,
        paperEndAt: true,
        bundle: {
          select: {
            class: {
              select: {
                id: true,
                name: true,
                students: {
                  where: { isActive: true },
                  select: {
                    student: {
                      select: {
                        id: true,
                        name: true,
                        registrationNumber: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!bundleItem) {
      throw new AppError("Bundle item not found.", 404, "BUNDLE_ITEM_NOT_FOUND");
    }

    if (bundleItem.type !== "PAPER") {
      throw new AppError("Submissions are available only for paper items.", 400, "VALIDATION_ERROR");
    }

    const studentIds = bundleItem.bundle.class.students.map((entry) => entry.student.id);

    const submissionDelegate = (prisma as { materialBundleItemSubmission?: { findMany: (...args: unknown[]) => unknown } })
      .materialBundleItemSubmission;

    if (!submissionDelegate) {
      throw new AppError(
        "Submission feature is not available because Prisma client is outdated. Run `npx prisma generate` and restart the dev server.",
        503,
        "PRISMA_CLIENT_OUTDATED"
      );
    }

    let submissions: Array<{
      id: string;
      studentId: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      submittedAt: Date;
    }> = [];

    if (studentIds.length > 0) {
      try {
        submissions = await submissionDelegate.findMany({
          where: {
            itemId,
            studentId: {
              in: studentIds,
            },
          },
          orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            studentId: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            submittedAt: true,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2021" || error.code === "P2022")
        ) {
          throw new AppError(
            "Submission storage is not ready. Run Prisma migrations and regenerate the client.",
            503,
            "SUBMISSION_SCHEMA_NOT_READY"
          );
        }

        throw error;
      }
    }

    const grouped = new Map<string, typeof submissions>();

    for (const submission of submissions) {
      const existing = grouped.get(submission.studentId) ?? [];
      existing.push(submission);
      grouped.set(submission.studentId, existing);
    }

    const supportMessages = studentIds.length
      ? await prisma.paperSupportMessage.findMany({
          where: {
            itemId,
            studentId: { in: studentIds },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            studentId: true,
            message: true,
            createdAt: true,
          },
        })
      : [];

    const supportMessagesByStudent = new Map<string, typeof supportMessages>();

    for (const msg of supportMessages) {
      const existing = supportMessagesByStudent.get(msg.studentId) ?? [];
      existing.push(msg);
      supportMessagesByStudent.set(msg.studentId, existing);
    }

    const students = bundleItem.bundle.class.students
      .map((entry) => {
        const student = entry.student;
        const studentSubmissions = grouped.get(student.id) ?? [];
        const studentSupportMessages = supportMessagesByStudent.get(student.id) ?? [];

        return {
          id: student.id,
          name: student.name,
          registrationNumber: student.registrationNumber,
          hasSubmitted: studentSubmissions.length > 0,
          latestSubmittedAt: studentSubmissions[0]?.submittedAt ?? null,
          supportMessages: studentSupportMessages.map((msg) => ({
            id: msg.id,
            message: msg.message,
            createdAt: msg.createdAt,
          })),
          submissions: studentSubmissions.map((submission) => ({
            id: submission.id,
            fileName: submission.fileName,
            mimeType: submission.mimeType,
            sizeBytes: submission.sizeBytes,
            submittedAt: submission.submittedAt,
            isLate: bundleItem.paperEndAt ? submission.submittedAt > bundleItem.paperEndAt : false,
          })),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return apiSuccess({
      item: {
        id: bundleItem.id,
        title: bundleItem.title,
        paperEndAt: bundleItem.paperEndAt,
      },
      classroom: {
        id: bundleItem.bundle.class.id,
        name: bundleItem.bundle.class.name,
      },
      students,
      summary: {
        totalStudents: students.length,
        submittedStudents: students.filter((student) => student.hasSubmitted).length,
        notSubmittedStudents: students.filter((student) => !student.hasSubmitted).length,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
