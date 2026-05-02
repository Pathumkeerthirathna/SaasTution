import { unlink } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateNoteSchema } from "@/lib/lecture-validation";
import { deleteNoteForTeacher, updateNoteForTeacher } from "@/services/lecture-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveNoteFilePath(fileUrl: string) {
  if (fileUrl.startsWith("/uploads/")) {
    return path.join(process.cwd(), "public", fileUrl);
  }

  return path.join(process.cwd(), "storage", fileUrl);
}

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
    return handleRouteError(error);
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

    const deletedNote = await deleteNoteForTeacher(session.teacherId, lectureId, noteId);

    const notePath = resolveNoteFilePath(deletedNote.fileUrl);
    await unlink(notePath).catch(() => undefined);

    return apiSuccess(
      {
        deleted: true,
      },
      {
        message: "Note deleted successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
