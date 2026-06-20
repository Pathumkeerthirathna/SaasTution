import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { updateClassSchema } from "@/lib/class-validation";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { deactivateClassForTeacher, updateClassForTeacher } from "@/services/class-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      name?: string;
      description?: string;
      monthlyFee?: number;
      paymentDueWeek?: number;
      schedule?: string;
      schedules?: {
        dayOfWeek?: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
        startTime?: string;
        endTime?: string;
      }[];
    };

    const parsed = updateClassSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const updatedClass = await updateClassForTeacher(classId, session.teacherId, parsed.data);

    return apiSuccess(
      {
        class: updatedClass,
      },
      {
        message: "Class updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

// export async function DELETE(
//   _request: Request,
//   context: {
//     params: { id: string };
//   }
// ) {
//   try {
//     const session = await requireTeacherSession();
//     const classId = context.params.id;

//     if (!classId?.trim()) {
//       throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
//     }

//     await deleteClassForTeacher(classId, session.teacherId);

//     return apiSuccess(
//       {
//         id: classId,
//       },
//       {
//         message: "Class deleted successfully.",
//       }
//     );
//   } catch (error) {
//     return handleRouteError(error);
//   }
// }

export async function DELETE(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError(
        "Class id is required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    await deactivateClassForTeacher(
      classId,
      session.teacherId
    );

    return apiSuccess(
      {
        id: classId,
      },
      {
        message: "Class deactivated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
