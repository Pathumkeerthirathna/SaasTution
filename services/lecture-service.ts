import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import {
  LECTURE_END_DATE_ERROR_CODES,
  LECTURE_END_DATE_MESSAGES,
  lectureEndDateProblem,
} from "@/lib/lecture-schedule";
import { prisma } from "@/lib/prisma";
import { emitStudentDataChange } from "@/lib/session-events";
import { readLectureWaiverState, recalculateAfterLectureChange } from "@/services/fee-waiver-events";
import {
  lockLectureForUpdate,
  lockRegisterKeyShared,
  runAttendanceTransaction,
  type AttendanceLocks,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { applyRegisterScheduleSync, prepareRegisterScheduleSync } from "@/services/lecture-attendance-service";
import { commitTeacherStorageReservation, type StorageReservationHandle } from "@/services/storage-reservation-service";
import { deleteAssignmentPermanently, deleteNotePermanently, type PermanentDeletionState } from "@/services/permanent-deletion-service";
import type {
  CreateAssignmentInput,
  CreateLectureInput,
  CreateQuizInput,
  UpdateAssignmentInput,
  UpdateLectureInput,
  UpdateNoteInput,
  UpdateQuizInput,
} from "@/lib/lecture-validation";

async function assertTeacherOwnsClass(teacherId: string, classId: string) {
  const classroom = await prisma.class.findFirst({
    where: {
      id: classId,
      teacherId,
      status: 0,
    },
    select: {
      id: true,
      name: true,
      schedule: true,
    },
  });

  if (!classroom) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return classroom;
}

export async function assertTeacherOwnsLecture(teacherId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: {
      id: lectureId,
      status: 0,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      title: true,
      classId: true,
      date: true,
      endDate: true,
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });

  if (!lecture) {
    throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
  }

  return lecture;
}

/** The hand-written CHECK constraint of migration 20261110120000_add_lecture_end_date. */
const LECTURE_END_DATE_CONSTRAINT = "Lecture_endDate_after_date";

/**
 * The database refused an end time that is not after the start (a
 * concurrent edit changed the stored start / end after the check below).
 * Recognized by the constraint name in the database error, whatever Prisma
 * error class carries it.
 */
function isLectureEndDateConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LECTURE_END_DATE_CONSTRAINT);
}

function lectureEndDateConstraintAppError(): AppError {
  return new AppError(
    LECTURE_END_DATE_MESSAGES.END_NOT_AFTER_START,
    400,
    LECTURE_END_DATE_ERROR_CODES.END_NOT_AFTER_START,
    { field: "endDate" }
  );
}

async function assertTeacherOwnsAssignment(teacherId: string, lectureId: string, assignmentId: string) {
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      lectureId,
      status: 0,
      lecture: {
        status: 0,
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      description: true,
      dueDate: true,
      lecture: { select: { classId: true } },
    },
  });

  if (!assignment) {
    throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
  }

  return assignment;
}

async function assertTeacherOwnsQuiz(teacherId: string, lectureId: string, quizId: string) {
  const quiz = await prisma.quiz.findFirst({
    where: {
      id: quizId,
      lectureId,
      status: 0,
      lecture: {
        status: 0,
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      lecture: { select: { classId: true } },
    },
  });

  if (!quiz) {
    throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
  }

  return quiz;
}

const quizWithQuestionsSelect = {
  id: true,
  lectureId: true,
  title: true,
  maxAttempts: true,
  startDateTime: true,
  endDateTime: true,
  questions: {
    orderBy: {
      orderIndex: "asc" as const,
    },
    select: {
      id: true,
      text: true,
      orderIndex: true,
      answerType: true,
      options: {
        orderBy: {
          orderIndex: "asc" as const,
        },
        select: {
          id: true,
          text: true,
          isCorrect: true,
          orderIndex: true,
        },
      },
    },
  },
};

async function assertTeacherOwnsNote(teacherId: string, lectureId: string, noteId: string) {
  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      lectureId,
      status: 0,
      lecture: {
        status: 0,
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      fileUrl: true,
      kind: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
      lecture: { select: { classId: true } },
    },
  });

  if (!note) {
    throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
  }

  return note;
}

export async function createLectureForTeacher(teacherId: string, input: CreateLectureInput) {
  await assertTeacherOwnsClass(teacherId, input.classId);

  // The request schema already checked endDate against date (createLectureSchema).
  const lecture = await prisma.lecture.create({
    data: {
      classId: input.classId,
      title: input.title,
      date: input.date,
      ...(input.endDate ? { endDate: input.endDate } : {}),
    },
    select: {
      id: true,
      title: true,
      date: true,
      endDate: true,
      classStatus: true,
      createdAt: true,
      class: {
        select: {
          id: true,
          name: true,
          schedule: true,
        },
      },
    },
  });

  emitStudentDataChange({ classId: input.classId });
  return lecture;
}

const UPDATED_LECTURE_SELECT = {
  id: true,
  title: true,
  date: true,
  endDate: true,
  classStatus: true,
  createdAt: true,
  class: {
    select: {
      id: true,
      name: true,
      schedule: true,
    },
  },
} as const;

/**
 * The start / end pair after this update: a side not in the request keeps
 * its stored value. A start-only change that no longer fits the stored end
 * is refused (the end is never cleared silently); `endDate: null` clears it.
 * Returns the error to throw, or null.
 */
function scheduleEditError(input: UpdateLectureInput, stored: { date: Date; endDate: Date | null }): AppError | null {
  const start = input.date ?? stored.date;
  const end = input.endDate !== undefined ? input.endDate : stored.endDate ?? null;
  const problem = lectureEndDateProblem(start, end);
  if (!problem) return null;

  const message =
    input.endDate === undefined
      ? `${LECTURE_END_DATE_MESSAGES[problem]} This lecture's end time does not fit the new start time: change the end time as well, or clear it.`
      : LECTURE_END_DATE_MESSAGES[problem];

  return new AppError(message, 400, LECTURE_END_DATE_ERROR_CODES[problem], { field: "endDate" });
}

/**
 * A schedule edit (start and / or end; Stage 5.4e) in one attendance
 * transaction, so the lecture and its OPEN attendance register change
 * together (docs/lecture-attendance.md, "Schedule synchronization"):
 *  1. the Lecture FOR NO KEY UPDATE (waits for attendance work holding it FOR
 *     SHARE; 3 s lock timeout: 409 ATTENDANCE_BUSY), then ownership, existence
 *     and soft delete re-checked under the lock (404 LECTURE_NOT_FOUND), and
 *     the new start / end re-checked against the LOCKED stored values (400);
 *  2. an existing register FOR UPDATE and, when it is open and the start
 *     moves, its records with evidence (prepareRegisterScheduleSync);
 *  3. write phase: the Lecture update, then the register sync
 *     (applyRegisterScheduleSync: open registers only; a finalized register,
 *     its records and its audits are left exactly as they are; no register
 *     is created; the grace is never changed).
 * Database errors are never caught inside the transaction.
 */
async function updateLectureScheduleInTransaction(
  locks: AttendanceLocks,
  input: { teacherId: string; lectureId: string; update: UpdateLectureInput }
) {
  const now = new Date();
  const locked = await lockLectureForUpdate(locks, input.lectureId);
  const owned =
    locked && locked.status === 0
      ? await locks.db.lecture.findFirst({
          where: { id: input.lectureId, status: 0, class: { teacherId: input.teacherId } },
          select: { id: true },
        })
      : null;
  if (!locked || !owned) throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");

  const problem = scheduleEditError(input.update, locked);
  if (problem) throw problem;

  const start = input.update.date ?? locked.date;
  const end = input.update.endDate !== undefined ? input.update.endDate : locked.endDate;
  const plan = await prepareRegisterScheduleSync(locks, { lectureId: input.lectureId, start, end });

  locks.beginWrites();
  const lecture = await locks.db.lecture.update({
    where: { id: input.lectureId },
    data: {
      ...(input.update.title !== undefined ? { title: input.update.title } : {}),
      ...(input.update.date !== undefined ? { date: input.update.date } : {}),
      ...(input.update.endDate !== undefined ? { endDate: input.update.endDate } : {}),
    },
    select: UPDATED_LECTURE_SELECT,
  });
  await applyRegisterScheduleSync(locks, plan, { actor: { role: "TEACHER", teacherId: input.teacherId }, now });
  return lecture;
}

/**
 * Cancelling or soft-deleting a lecture (Stage 5.4e guard) in one attendance
 * transaction: the Lecture FOR NO KEY UPDATE (ownership, existence and soft
 * delete re-checked under the lock), then an existing register FOR KEY SHARE:
 * finalized means 409 LECTURE_ATTENDANCE_FINALIZED and nothing changes (a
 * finalized lecture keeps its attendance). Then the write.
 */
async function guardedLectureWriteInTransaction(
  locks: AttendanceLocks,
  input: { teacherId: string; lectureId: string; data: { classStatus: "CANCELLED" } | { status: 1 } }
) {
  const locked = await lockLectureForUpdate(locks, input.lectureId);
  const owned =
    locked && locked.status === 0
      ? await locks.db.lecture.findFirst({
          where: { id: input.lectureId, status: 0, class: { teacherId: input.teacherId } },
          select: { id: true },
        })
      : null;
  if (!locked || !owned) throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");

  const register = await lockRegisterKeyShared(locks, input.lectureId);
  if (register?.finalizedAt) throw attendanceError("LECTURE_ATTENDANCE_FINALIZED");

  locks.beginWrites();
  return locks.db.lecture.update({ where: { id: input.lectureId }, data: input.data, select: UPDATED_LECTURE_SELECT });
}

export async function updateLectureForTeacher(teacherId: string, lectureId: string, input: UpdateLectureInput) {
  const stored = await assertTeacherOwnsLecture(teacherId, lectureId);
  const scheduleEdit = input.date !== undefined || input.endDate !== undefined;

  if (scheduleEdit) {
    const problem = scheduleEditError(input, stored);
    if (problem) throw problem;
  }

  const waiverBefore = await readLectureWaiverState(lectureId);

  let lecture;

  try {
    lecture = scheduleEdit
      ? // Start / end: the lecture and its open attendance register, atomically.
        await runAttendanceTransaction((locks) =>
          updateLectureScheduleInTransaction(locks, { teacherId, lectureId, update: input })
        )
      : // Title only: the existing autocommit update (E2).
        await prisma.lecture.update({
          where: {
            id: lectureId,
          },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
          },
          select: UPDATED_LECTURE_SELECT,
        });
  } catch (error) {
    if (isLectureEndDateConstraintError(error)) throw lectureEndDateConstraintAppError();
    throw error;
  }

  // Automatic joining waivers: a COMPLETED lecture moving date or billing
  // month. After the update, outside it; never fails the lecture update.
  await recalculateAfterLectureChange(waiverBefore, waiverBefore && { ...waiverBefore, date: lecture.date });

  return lecture;
}

export async function updateLectureClassStatusForTeacher(
  teacherId: string,
  lectureId: string,
  classStatus: "COMPLETED" | "CANCELLED"
) {
  await assertTeacherOwnsLecture(teacherId, lectureId);
  const waiverBefore = await readLectureWaiverState(lectureId);

  const lecture =
    classStatus === "CANCELLED"
      ? // Refused (409 LECTURE_ATTENDANCE_FINALIZED) when the attendance is finalized.
        await runAttendanceTransaction((locks) =>
          guardedLectureWriteInTransaction(locks, { teacherId, lectureId, data: { classStatus: "CANCELLED" } })
        )
      : await prisma.lecture.update({
          where: {
            id: lectureId,
          },
          data: {
            classStatus,
          },
          select: UPDATED_LECTURE_SELECT,
        });

  // Automatic joining waivers: entering or leaving COMPLETED. After the
  // update, outside it; never fails the status change.
  await recalculateAfterLectureChange(
    waiverBefore,
    waiverBefore && { ...waiverBefore, classStatus: lecture.classStatus }
  );

  return lecture;
}

export async function deleteLectureForTeacher(teacherId: string, lectureId: string) {
  const lecture = await assertTeacherOwnsLecture(teacherId, lectureId);
  const waiverBefore = await readLectureWaiverState(lectureId);

  // Soft delete: status 1 hides the lecture (and, via lecture.status filters, its
  // notes / assignments / quizzes) from every view while keeping history intact.
  // Refused (409 LECTURE_ATTENDANCE_FINALIZED) when the attendance is finalized.
  await runAttendanceTransaction((locks) =>
    guardedLectureWriteInTransaction(locks, { teacherId, lectureId, data: { status: 1 } })
  );

  emitStudentDataChange({ classId: lecture.classId });

  // Automatic joining waivers: a removed COMPLETED lecture no longer counts.
  // After the update, outside it; never fails the deletion.
  await recalculateAfterLectureChange(waiverBefore, waiverBefore && { ...waiverBefore, status: 1 });
}

export async function listLecturesForTeacher(params: {
  teacherId: string;
  classId?: string;
  lectureId?: string;
  title?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortOrder?: "asc" | "desc";
  skip: number;
  take: number;
}) {
  if (params.classId) {
    await assertTeacherOwnsClass(params.teacherId, params.classId);
  }

  const where = {
    status: 0,
    class: {
      teacherId: params.teacherId,
      status: 0,
    },
    ...(params.lectureId
      ? {
          id: params.lectureId,
        }
      : {}),
    ...(params.classId
      ? {
          classId: params.classId,
        }
      : {}),
    ...(params.title
      ? {
          title: {
            contains: params.title,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          date: {
            ...(params.dateFrom ? { gte: params.dateFrom } : {}),
            ...(params.dateTo ? { lte: params.dateTo } : {}),
          },
        }
      : {}),
  };

  const [lectures, totalItems] = await Promise.all([
    prisma.lecture.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: {
        date: params.sortOrder === "asc" ? "asc" : "desc",
      },
      select: {
        id: true,
        title: true,
        date: true,
        endDate: true,
        classStatus: true,
        createdAt: true,
        class: {
          select: {
            id: true,
            name: true,
            schedule: true,
          },
        },
        _count: {
          select: {
            notes: { where: { status: 0 } },
            assignments: { where: { status: 0 } },
            quizzes: { where: { status: 0 } },
            whiteboards: { where: { status: 0 } },
          },
        },
      },
    }),
    prisma.lecture.count({
      where,
    }),
  ]);

  return {
    lectures,
    totalItems,
  };
}

export async function listNotesForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.note.findMany({
    where: {
      lectureId,
      status: 0,
    },
    orderBy: {
      id: "desc",
    },
    select: noteSelect,
  });
}

// The teacher-facing Note shape. No fileUrl / storageKey (unified storage
// Stage 2): files are served by id through the preview / download routes, and
// neither a legacy path nor a storage key is needed by the client.
const noteSelect = {
  id: true,
  lectureId: true,
  title: true,
  kind: true,
  mimeType: true,
  sizeBytes: true,
  downloadCount: true,
  lastDownloadedAt: true,
  visibility: true,
  access: true,
} as const;

export async function listAssignmentsForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.assignment.findMany({
    where: {
      lectureId,
      status: 0,
    },
    orderBy: {
      dueDate: "asc",
    },
    select: {
      id: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });
}

export async function listQuizzesForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.quiz.findMany({
    where: {
      lectureId,
      status: 0,
    },
    orderBy: [{ id: "desc" }],
    select: quizWithQuestionsSelect,
  });
}

export async function listRecordingsForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.youTubeRecording.findMany({
    where: {
      lectureId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      videoId: true,
      youtubeUrl: true,
      privacy: true,
      status: true,
      visibility: true,
      access: true,
      startedAt: true,
      endedAt: true,
      createdAt: true,
    },
  });
}

export async function listSessionsForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.classSession.findMany({
    where: {
      lectureId,
    },
    orderBy: {
      startedAt: "desc",
    },
    select: {
      id: true,
      roomName: true,
      jitsiDomain: true,
      startedAt: true,
      endedAt: true,
      isActive: true,
      createdAt: true,
      _count: {
        select: {
          attendance: { where: { student: { status: 0 } } },
        },
      },
    },
  });
}

async function assertTeacherOwnsRecording(teacherId: string, recordingId: string) {
  const recording = await prisma.youTubeRecording.findFirst({
    where: {
      id: recordingId,
      lecture: {
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      lectureId: true,
    },
  });

  if (!recording) {
    throw new AppError("Recording not found.", 404, "RECORDING_NOT_FOUND");
  }

  return recording;
}

export async function updateRecordingAccessForTeacher(
  teacherId: string,
  recordingId: string,
  input: { visibility?: "PUBLIC" | "PRIVATE"; access?: "FREE" | "LOCKED" }
) {
  await assertTeacherOwnsRecording(teacherId, recordingId);

  return prisma.youTubeRecording.update({
    where: {
      id: recordingId,
    },
    data: {
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.access !== undefined ? { access: input.access } : {}),
    },
    select: {
      id: true,
      videoId: true,
      youtubeUrl: true,
      privacy: true,
      status: true,
      visibility: true,
      access: true,
      startedAt: true,
      endedAt: true,
      createdAt: true,
    },
  });
}

export async function listLiveBroadcastsForLectureForTeacher(teacherId: string, lectureId: string) {
  await assertTeacherOwnsLecture(teacherId, lectureId);

  return prisma.youTubeLiveBroadcast.findMany({
    where: {
      lectureId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      videoId: true,
      youtubeUrl: true,
      privacy: true,
      status: true,
      startedAt: true,
      endedAt: true,
      createdAt: true,
    },
  });
}

export async function addAssignmentToLectureForTeacher(
  teacherId: string,
  lectureId: string,
  input: CreateAssignmentInput
) {
  const lecture = await assertTeacherOwnsLecture(teacherId, lectureId);

  const created = await prisma.assignment.create({
    data: {
      lectureId,
      title: input.title,
      description: input.description,
      dueDate: input.dueDate,
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });

  emitStudentDataChange({ classId: lecture.classId });
  return created;
}

export async function updateAssignmentForTeacher(
  teacherId: string,
  lectureId: string,
  assignmentId: string,
  input: UpdateAssignmentInput
) {
  await assertTeacherOwnsAssignment(teacherId, lectureId, assignmentId);

  return prisma.assignment.update({
    where: {
      id: assignmentId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    },
    select: {
      id: true,
      lectureId: true,
      title: true,
      description: true,
      dueDate: true,
    },
  });
}

/**
 * PERMANENT deletion (Stage 3.6): the assignment, every student submission
 * and every submission PDF (services/permanent-deletion-service.ts). DELETED
 * when everything is gone; PENDING when it is hidden everywhere and the rest
 * is finished by a retry (the same request again, or maintenance).
 */
export async function deleteAssignmentForTeacher(teacherId: string, lectureId: string, assignmentId: string): Promise<PermanentDeletionState> {
  const result = await deleteAssignmentPermanently({ teacherId, lectureId, assignmentId });
  emitStudentDataChange({ classId: result.classId });
  return result.state;
}

export async function addQuizToLectureForTeacher(
  teacherId: string,
  lectureId: string,
  input: CreateQuizInput
) {
  const lecture = await assertTeacherOwnsLecture(teacherId, lectureId);

  const created = await prisma.quiz.create({
    data: {
      lectureId,
      title: input.title,
      maxAttempts: input.maxAttempts ?? null,
      startDateTime: input.startDateTime,
      endDateTime: input.endDateTime,
      questions: {
        create: input.questions.map((question, questionIndex) => ({
          text: question.text,
          orderIndex: questionIndex,
          answerType: question.answerType,
          options: {
            create: question.options.map((option, optionIndex) => ({
              text: option.text,
              isCorrect: option.isCorrect,
              orderIndex: optionIndex,
            })),
          },
        })),
      },
    },
    select: quizWithQuestionsSelect,
  });

  emitStudentDataChange({ classId: lecture.classId });
  return created;
}

export async function updateQuizForTeacher(
  teacherId: string,
  lectureId: string,
  quizId: string,
  input: UpdateQuizInput
) {
  await assertTeacherOwnsQuiz(teacherId, lectureId, quizId);

  return prisma.quiz.update({
    where: {
      id: quizId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.startDateTime !== undefined ? { startDateTime: input.startDateTime } : {}),
      ...(input.endDateTime !== undefined ? { endDateTime: input.endDateTime } : {}),
      questions: {
        deleteMany: {},
        create: input.questions.map((question, questionIndex) => ({
          text: question.text,
          orderIndex: questionIndex,
          answerType: question.answerType,
          options: {
            create: question.options.map((option, optionIndex) => ({
              text: option.text,
              isCorrect: option.isCorrect,
              orderIndex: optionIndex,
            })),
          },
        })),
      },
    },
    select: quizWithQuestionsSelect,
  });
}

export async function deleteQuizForTeacher(teacherId: string, lectureId: string, quizId: string) {
  const quiz = await assertTeacherOwnsQuiz(teacherId, lectureId, quizId);

  // Soft delete — keep questions and submissions.
  await prisma.quiz.update({
    where: {
      id: quizId,
    },
    data: {
      status: 1,
    },
  });

  emitStudentDataChange({ classId: quiz.lecture.classId });
}

export async function addNoteToLectureForTeacher(params: {
  teacherId: string;
  lectureId: string;
  title: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
  kind: "NOTE" | "SUPPORTING_MATERIAL";
  /** Unified storage (Stage 2): the server-generated note id the stored file's key was built with. */
  id?: string;
  storageKey?: string;
  sha256?: string;
  /**
   * Called when the Note row was NOT created (ownership re-check or insert
   * failed), so the caller can remove the file it already stored. Never
   * called once the row exists (the file is then referenced).
   */
  discardStoredFile?: () => Promise<unknown>;
  /**
   * Storage quota (Stage 3.2): the upload's reservation. The Note row is then
   * created inside commitTeacherStorageReservation - under the teacher's quota
   * lock, atomically with the reservation's deletion, and only if the quota
   * still allows it when the reservation has expired.
   */
  reservation?: StorageReservationHandle;
}) {
  let lecture: Awaited<ReturnType<typeof assertTeacherOwnsLecture>>;
  let note;
  try {
    lecture = await assertTeacherOwnsLecture(params.teacherId, params.lectureId);
    const createNote = (client: Pick<Prisma.TransactionClient, "note">) =>
      client.note.create({
        data: {
          ...(params.id !== undefined ? { id: params.id } : {}),
          lectureId: params.lectureId,
          title: params.title,
          fileUrl: params.fileUrl,
          ...(params.storageKey !== undefined ? { storageKey: params.storageKey, sha256: params.sha256 } : {}),
          kind: params.kind,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
        },
        select: noteSelect,
      });
    note = params.reservation
      ? await commitTeacherStorageReservation(params.reservation, "TEACHER", (tx) => createNote(tx))
      : await createNote(prisma);
  } catch (error) {
    await params.discardStoredFile?.();
    throw error;
  }

  // Track a per-student "viewed" row for every active student of the class.
  const activeStudents = await prisma.classStudent.findMany({
    where: { classId: lecture.classId, isActive: true, student: { status: 0 } },
    select: { studentId: true },
  });
  if (activeStudents.length > 0) {
    await prisma.noteStudent.createMany({
      data: activeStudents.map((s) => ({ noteId: note.id, studentId: s.studentId })),
      skipDuplicates: true,
    });
  }

  emitStudentDataChange({ classId: lecture.classId });
  return note;
}

export async function updateNoteForTeacher(
  teacherId: string,
  lectureId: string,
  noteId: string,
  input: UpdateNoteInput
) {
  await assertTeacherOwnsNote(teacherId, lectureId, noteId);

  return prisma.note.update({
    where: {
      id: noteId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.access !== undefined ? { access: input.access } : {}),
    },
    select: noteSelect,
  });
}

/**
 * PERMANENT deletion (Stage 3.6): the note row (and its per-student view
 * rows) and its stored file (services/permanent-deletion-service.ts).
 * DELETED or PENDING (hidden everywhere; finished by a retry).
 */
export async function deleteNoteForTeacher(teacherId: string, lectureId: string, noteId: string): Promise<PermanentDeletionState> {
  const result = await deleteNotePermanently({ teacherId, lectureId, noteId });
  emitStudentDataChange({ classId: result.classId });
  return result.state;
}

export async function getAndTrackNoteDownloadForTeacher(teacherId: string, noteId: string) {
  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      status: 0,
      lecture: {
        status: 0,
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      title: true,
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });

  if (!note) {
    throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
  }

  return prisma.note.update({
    where: {
      id: noteId,
    },
    data: {
      downloadCount: {
        increment: 1,
      },
      lastDownloadedAt: new Date(),
    },
    select: {
      id: true,
      title: true,
      fileUrl: true,
      storageKey: true,
      mimeType: true,
      sizeBytes: true,
      downloadCount: true,
      lastDownloadedAt: true,
    },
  });
}
