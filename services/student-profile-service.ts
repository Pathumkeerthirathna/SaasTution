/**
 * The signed-in student's own profile, read only (Student Profile SP-2).
 *
 * The student id always comes from the caller's authenticated session (the
 * route passes `session.studentId`); this module never takes one from a
 * request. Only the fields the profile page shows are read and returned:
 * never the password hash, tokens or verification codes, the teacher id, or
 * approval / confirmation metadata.
 *
 *  - name: teacher-managed (shown read only);
 *  - registrationNumber: the student ID;
 *  - email and whether it is confirmed;
 *  - phone: `contact01`, the student's own phone number (product decision);
 *  - registeredOn: the registration date as a calendar date (YYYY-MM-DD),
 *    never a timestamp.
 *
 * Unavailable accounts: a missing or deleted (status 2) student is 404
 * STUDENT_NOT_FOUND (a deleted account looks like an unknown one, as at
 * sign-in); an inactive (status 1) student is 403 STUDENT_ACCOUNT_INACTIVE.
 */

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export type StudentOwnProfile = {
  /** Teacher-managed: students cannot change it. */
  name: string;
  /** The student ID (null only for a student who was never given one). */
  registrationNumber: string | null;
  email: string | null;
  emailVerified: boolean;
  /** The student's own phone number (Student.contact01). */
  phone: string | null;
  /** Calendar date of registration, YYYY-MM-DD (see registeredOnOf). */
  registeredOn: string | null;
};

const ACTIVE = 0;
const INACTIVE = 1;

/**
 * Student.registeredAt is written by the database default (CURRENT_TIMESTAMP
 * into `timestamp without time zone`): its digits are the database session's
 * wall-clock time, which the application cannot know. The stored calendar
 * date is therefore shown as stored (read back as UTC digits), never
 * re-converted to another zone and never shown with a time of day.
 */
export function registeredOnOf(value: Date | null | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

const nonBlank = (value: string | null | undefined) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * Replaces the signed-in student's own phone number (`contact01`, Student
 * Profile SP-3) and returns the profile as GET shows it. The caller passes
 * the session's student id and an already validated number
 * (lib/student-profile-validation.ts). Only `contact01` is written, and only
 * while the account is active: the update itself is conditioned on
 * `status: 0`, so an account deactivated or deleted at the same moment is
 * never written. Missing / deleted: 404 STUDENT_NOT_FOUND; inactive: 403
 * STUDENT_ACCOUNT_INACTIVE (the same answers as GET).
 */
export async function updateStudentOwnPhone(studentId: string, contact01: string): Promise<StudentOwnProfile> {
  if (typeof studentId !== "string" || studentId.trim() === "") {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }
  if (typeof contact01 !== "string" || contact01.trim() === "") {
    throw new AppError("Enter a phone number.", 400, "VALIDATION_ERROR", { field: "contact01" });
  }

  const updated = await prisma.student.updateMany({
    where: { id: studentId, status: ACTIVE },
    data: { contact01: contact01.trim() },
  });

  // Nothing written: the account is missing, deleted or inactive (the read
  // answers with that code). Should it have become active in between, say so
  // rather than report a save that did not happen.
  if (updated.count === 0) {
    await getStudentOwnProfile(studentId);
    throw new AppError("Your profile could not be updated. Please try again.", 409, "PROFILE_UPDATE_CONFLICT");
  }
  return getStudentOwnProfile(studentId);
}

export async function getStudentOwnProfile(studentId: string): Promise<StudentOwnProfile> {
  if (typeof studentId !== "string" || studentId.trim() === "") {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      name: true,
      registrationNumber: true,
      email: true,
      emailConfirmed: true,
      contact01: true,
      registeredAt: true,
      status: true,
    },
  });

  if (!student || (student.status !== ACTIVE && student.status !== INACTIVE)) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }
  if (student.status === INACTIVE) {
    throw new AppError("Your student account is inactive. Please contact your teacher.", 403, "STUDENT_ACCOUNT_INACTIVE");
  }

  // Explicit mapping: nothing is spread from the database row.
  return {
    name: student.name,
    registrationNumber: nonBlank(student.registrationNumber),
    email: nonBlank(student.email),
    emailVerified: student.emailConfirmed === true,
    phone: nonBlank(student.contact01),
    registeredOn: registeredOnOf(student.registeredAt),
  };
}
