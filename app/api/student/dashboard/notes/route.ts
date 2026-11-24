import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { CLASS_NOTES_ORDER } from "@/services/class-notes-service";
import { loadStudentResourceAccess, noteBillingMonth, resourceLockFor } from "@/services/resource-access-service";

export const dynamic = "force-dynamic";

// GET /api/student/dashboard/notes
// Lecture notes (kind = NOTE) from the student's active classes that they have
// not viewed yet, General Notes (the class's default lecture) included. A note
// counts as unviewed when there is no NoteStudent row or its `viewed` flag is
// false. Tutes, papers and material-bundle items are not included here.
// Newest upload first (uploadedAt; notes from before uploadedAt existed last,
// by their lecture's date), the same order as the Notes pages.
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const studentId = session.studentId;

    const rows = await prisma.note.findMany({
      where: {
        status: 0,
        kind: "NOTE",
        lecture: {
          status: 0,
          class: {
            status: 0,
            students: { some: { studentId, isActive: true } },
          },
        },
        noteStudents: { none: { studentId, viewed: true } },
      },
      orderBy: CLASS_NOTES_ORDER,
      take: 20,
      select: {
        id: true,
        title: true,
        mimeType: true,
        sizeBytes: true,
        uploadedAt: true,
        lecture: {
          select: {
            id: true,
            title: true,
            date: true,
            isDefault: true,
            classId: true,
            class: { select: { name: true } },
          },
        },
      },
    });

    // Monthly resource access (one batched load): a locked month's note is
    // listed locked; its file route refuses it.
    const access = await loadStudentResourceAccess(studentId, { classIds: [...new Set(rows.map((n) => n.lecture.classId))] });
    const notes = rows.map((n) => ({
      id: n.id,
      title: n.title,
      mimeType: n.mimeType,
      sizeBytes: n.sizeBytes,
      lectureId: n.lecture.id,
      lectureTitle: n.lecture.title,
      className: n.lecture.class.name,
      classId: n.lecture.classId,
      /** A General Note (the class's default lecture): its lecture date is the class's creation, never shown as a note date. */
      isGeneral: n.lecture.isDefault,
      /** The real upload instant; null for notes uploaded before it was recorded. */
      uploadedAt: n.uploadedAt ? n.uploadedAt.toISOString() : null,
      /** The lecture's date (unchanged field). */
      date: n.lecture.date.toISOString(),
      resourceAccess: resourceLockFor(access, n.lecture.classId, noteBillingMonth(n)),
    }));

    return apiSuccess({ notes });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
