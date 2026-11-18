import { randomUUID } from "node:crypto";

import { apiError, apiSuccess } from "@/lib/api-response";
import { generateSubmissionStoredName, submissionFileKey } from "@/lib/assignments/submission-keys";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { submitAssignmentSchema } from "@/lib/lecture-validation";
import { emitStudentDataChange } from "@/lib/session-events";
import { prisma } from "@/lib/prisma";
import { discardStoredUpload, removeReplacedUpload, storeUpload, type StoredUploadResult } from "@/lib/stored-files/stored-file";
import {
  commitTeacherStorageReservation,
  releaseTeacherStorageReservation,
  reserveTeacherStorage,
} from "@/services/storage-reservation-service";
import { assertContentAccessForStudent } from "@/services/class-access-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_MIME_TYPE = "application/pdf";
const MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;

/** Attempts of the write-then-compare-and-set cycle before a concurrent resubmission is reported. */
const MAX_SUBMISSION_ATTEMPTS = 3;

// The student-facing submission shape: no fileUrl / storageKey (the file is
// served by /api/assignments/[assignmentId]/submit/file).
const SUBMISSION_SELECT = {
  id: true,
  notes: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  submittedAt: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

// GET /api/assignments/[assignmentId]/submit
// Returns the current student's submission for this assignment, if any.
export async function GET(
  _request: Request,
  context: { params: { assignmentId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const { assignmentId } = context.params;

    if (!assignmentId?.trim()) {
      throw new AppError("Assignment id is required.", 400, "VALIDATION_ERROR");
    }
    // Payment-due access control (services/class-access-service.ts).
    await assertContentAccessForStudent(studentSession.studentId, { assignmentId });

    // Verify the assignment exists and belongs to one of the student's enrolled classes.
    const assignment = await prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        status: 0,
        lecture: {
          status: 0,
          class: {
            students: {
              some: {
                studentId: studentSession.studentId,
                isActive: true,
              },
            },
          },
        },
      },
      select: { id: true },
    });

    if (!assignment) {
      throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
    }

    const submission = await prisma.assignmentSubmission.findUnique({
      where: {
        assignmentId_studentId: {
          assignmentId,
          studentId: studentSession.studentId,
        },
      },
      select: SUBMISSION_SELECT,
    });

    return apiSuccess({ submission: submission ?? null });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}

// POST /api/assignments/[assignmentId]/submit
// Creates or replaces the current student's submission.
//
// Unified storage (Stage 2). For each attempt:
//   1. read the student's current submission (its id and file reference);
//   2. write the PDF COMPLETELY to a NEW key (exact size, SHA-256, flushed)
//      Teachers/{teacher}/Lectures/{lecture}/Assignments/{assignment}/
//      Submissions/{submissionId}/{random}.pdf - the submission id is kept for
//      a resubmission (as the previous upsert did), new for a first one -
//      and, while the rollback window is open, a verified legacy copy
//      (storage/assignments/{assignment}/{random}.pdf) that fileUrl points to;
//   3. commit the reference: a first submission is created (the unique
//      (assignmentId, studentId) index decides a race between two first
//      submissions); a resubmission is a compare-and-set on the file
//      reference read in step 1, so a concurrent resubmission is never
//      silently overwritten - the loser removes its own new file and retries;
//   4. only AFTER the commit, remove the previous upload's files if this
//      feature wrote them (its new-storage file and its paired legacy copy);
//      a file of the old application (storageKey null) is never deleted:
//      legacy files are retained for the storage migration.
// A failed write leaves no file; a failed commit removes the new files; the
// database never references an incomplete file.
export async function POST(
  request: Request,
  context: { params: { assignmentId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const { assignmentId } = context.params;

    if (!assignmentId?.trim()) {
      throw new AppError("Assignment id is required.", 400, "VALIDATION_ERROR");
    }
    // Payment-due access control (services/class-access-service.ts).
    await assertContentAccessForStudent(studentSession.studentId, { assignmentId });

    const formData = await request.formData();
    const notes = String(formData.get("notes") ?? "").trim();
    const fileEntry = formData.get("file");
    const body = { notes: notes || undefined };
    const parsed = submitAssignmentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    if (!(fileEntry instanceof File)) {
      return apiError("PDF file is required.", 400, "VALIDATION_ERROR");
    }

    if (fileEntry.type !== PDF_MIME_TYPE) {
      return apiError("Only PDF files are allowed for assignment submissions.", 400, "UNSUPPORTED_FILE_TYPE");
    }

    if (fileEntry.size > MAX_PDF_SIZE_BYTES) {
      return apiError("PDF file exceeds size limit of 25 MB.", 400, "FILE_TOO_LARGE");
    }

    // Verify the assignment exists and belongs to one of the student's enrolled classes.
    const assignment = await prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        status: 0,
        lecture: {
          status: 0,
          class: {
            students: {
              some: {
                studentId: studentSession.studentId,
                isActive: true,
              },
            },
          },
        },
      },
      select: { id: true, dueDate: true, lectureId: true, lecture: { select: { classId: true, class: { select: { teacherId: true } } } } },
    });

    if (!assignment) {
      throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
    }

    const studentId = studentSession.studentId;
    const fileName = fileEntry.name || "submission.pdf";

    for (let attempt = 1; attempt <= MAX_SUBMISSION_ATTEMPTS; attempt++) {
      const existing = await prisma.assignmentSubmission.findUnique({
        where: { assignmentId_studentId: { assignmentId, studentId } },
        select: { id: true, fileUrl: true, storageKey: true },
      });

      const submissionId = existing?.id ?? randomUUID();
      const storageKey = submissionFileKey({
        teacherId: assignment.lecture.class.teacherId,
        lectureId: assignment.lectureId,
        assignmentId,
        submissionId,
        storedName: generateSubmissionStoredName(),
      });

      // Storage quota (Stage 3.2): the FULL new size must fit in the teacher's quota (the file
      // it may replace still counts until the replacement commits). Students get a generic
      // 413 message without the teacher's figures.
      const reservation = await reserveTeacherStorage({
        teacherId: assignment.lecture.class.teacherId,
        category: "SUBMISSION",
        storageKey,
        bytes: BigInt(fileEntry.size),
        audience: "STUDENT",
      });
      let stored: StoredUploadResult;
      try {
        stored = await storeUpload("SUBMISSION", storageKey, fileEntry, MAX_PDF_SIZE_BYTES);
      } catch (error) {
        await releaseTeacherStorageReservation(reservation, "Assignment submission: release the storage reservation of a failed write");
        throw error;
      }

      const submittedAt = new Date();
      const data = {
        fileName,
        fileUrl: stored.fileUrl,
        storageKey,
        sha256: stored.sha256,
        mimeType: fileEntry.type,
        sizeBytes: stored.sizeBytes,
        notes: parsed.data.notes ?? null,
        submittedAt,
      };

      // The row write and the reservation's removal commit together under the teacher's
      // quota lock (a lost compare-and-set also removes this attempt's reservation there).
      let committed = false;
      try {
        committed = await commitTeacherStorageReservation(reservation, "STUDENT", async (tx) => {
          // Stage 3.6: re-checked under the teacher's quota lock, which permanent deletion's
          // finalize also takes: an assignment marked for deletion accepts no new submission.
          if ((await tx.assignment.count({ where: { id: assignmentId, status: 0 } })) === 0) {
            throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
          }
          if (existing) {
            // Compare-and-set: only if nobody replaced the file since step 1.
            const result = await tx.assignmentSubmission.updateMany({
              where: { id: existing.id, fileUrl: existing.fileUrl, storageKey: existing.storageKey },
              data,
            });
            return result.count === 1;
          }
          await tx.assignmentSubmission.create({
            data: { id: submissionId, assignmentId, studentId, ...data },
            select: { id: true },
          });
          return true;
        });
      } catch (error) {
        // Nothing was committed: only THIS attempt's files and reservation are removed.
        await discardStoredUpload(stored, "Assignment submission: discard the files of a submission that was not saved");
        await releaseTeacherStorageReservation(reservation, "Assignment submission: release the storage reservation of a submission that was not saved");
        // Another first submission won the unique (assignmentId, studentId) race: retry as a resubmission.
        if (!existing && isUniqueViolation(error)) continue;
        throw error;
      }

      if (!committed) {
        // Lost the compare-and-set: the reservation is already gone; the current submission's files are untouched.
        await discardStoredUpload(stored, "Assignment submission: discard the files of a superseded concurrent resubmission");
        continue;
      }

      // The new reference is committed; the previous upload's own files are no longer referenced.
      if (existing && existing.storageKey !== storageKey) {
        await removeReplacedUpload("SUBMISSION", existing, "Assignment submission: remove the replaced submission files");
      }

      emitStudentDataChange({
        studentId,
        classId: assignment.lecture.classId,
      });

      const submission = {
        id: submissionId,
        notes: data.notes,
        fileName,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        submittedAt,
      };
      return apiSuccess({ submission }, { message: "Assignment submitted successfully.", status: 201 });
    }

    throw new AppError(
      "Another submission for this assignment was saved at the same time. Please try again.",
      409,
      "SUBMISSION_CONFLICT"
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
