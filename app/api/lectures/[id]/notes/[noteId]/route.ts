import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateNoteSchema } from "@/lib/lecture-validation";
import { deleteNoteForTeacher, updateNoteForTeacher } from "@/services/lecture-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string; noteId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const noteId = context.params.noteId;

    if (!lectureId?.trim() || !noteId?.trim()) {
      throw new AppError("Lecture id and note id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      title?: string;
      kind?: "NOTE" | "SUPPORTING_MATERIAL";
      visibility?: "PUBLIC" | "PRIVATE";
      access?: "FREE" | "LOCKED";
    };

    const parsed = updateNoteSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const note = await updateNoteForTeacher(session.teacherId, lectureId, noteId, parsed.data);

    return apiSuccess(
      {
        note,
      },
      {
        message: "Note updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function DELETE(
  _request: Request,
  context: {
    params: { id: string; noteId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const noteId = context.params.noteId;

    if (!lectureId?.trim() || !noteId?.trim()) {
      throw new AppError("Lecture id and note id are required.", 400, "VALIDATION_ERROR");
    }

    // PERMANENT deletion (Stage 3.6): the note and its file. 200 only when both are gone;
    // 202 when it is hidden and the file deletion is still pending (retried automatically).
    const state = await deleteNoteForTeacher(session.teacherId, lectureId, noteId);

    if (state === "PENDING") {
      return apiSuccess(
        { deleted: false, pending: true },
        {
          message: "The note was removed. Its file is still being deleted and will be removed automatically.",
          status: 202,
        }
      );
    }

    return apiSuccess(
      {
        deleted: true,
        pending: false,
      },
      {
        message: "Note deleted permanently.",
      }
    );
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
