import { randomBytes } from "crypto";

import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

import type {
  CreateGuardianInput,
  GuardianLoginInput,
  LinkGuardianInput,
  UpdateGuardianDetailsInput,
  UpdateGuardianLinkInput,
} from "@/lib/guardian-validation";
import { AppError } from "@/lib/error-handler";
import { assertEmailAvailable } from "@/lib/email-uniqueness";
import { prisma } from "@/lib/prisma";
import { buildGuardianLoginLink, sendGuardianRegistrationEmail } from "@/lib/mailer";

const HASH_ROUNDS = 12;

/**
 * A teacher may manage a guardian for a student they own, or a student who is
 * actively enrolled in one of their classes.
 */
async function assertTeacherCanManageStudent(teacherId: string, studentId: string) {
  const student = await prisma.student.findFirst({
    where: {
      id: studentId,
      OR: [
        { teacherId },
        { classes: { some: { isActive: true, class: { teacherId } } } },
      ],
    },
    select: { id: true, name: true },
  });

  if (!student) {
    throw new AppError(
      "Student is not one of your students.",
      403,
      "STUDENT_NOT_ACCESSIBLE"
    );
  }

  return student;
}

function generatePassword() {
  // ~11 url-safe characters.
  return randomBytes(8).toString("base64url");
}

const guardianPublicSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  createdAt: true,
} as const;

export async function loginGuardian(input: GuardianLoginInput) {
  const guardian = await prisma.guardian.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      password: true,
    },
  });

  if (!guardian) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  const passwordMatches = await bcrypt.compare(input.password, guardian.password);

  if (!passwordMatches) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  return {
    id: guardian.id,
    fullName: guardian.fullName,
    email: guardian.email,
    phone: guardian.phone,
  };
}

/**
 * Teacher creates a fresh guardian account and links it to one of their
 * students. A password is generated and emailed to the guardian.
 */
export async function createGuardianWithAccount(
  teacherId: string,
  input: CreateGuardianInput
) {
  const student = await assertTeacherCanManageStudent(teacherId, input.studentId);

  await assertEmailAvailable(input.email);

  const nameTaken = await prisma.guardian.findUnique({
    where: { fullName: input.fullName },
    select: { id: true },
  });

  if (nameTaken) {
    throw new AppError(
      "A guardian with this full name already exists. Search for and link the existing guardian instead.",
      409,
      "GUARDIAN_NAME_EXISTS"
    );
  }

  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);

  const guardian = await prisma.guardian.create({
    data: {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      password: passwordHash,
      students: {
        create: {
          studentId: input.studentId,
          relation: input.relation,
        },
      },
    },
    select: guardianPublicSelect,
  });

  try {
    await sendGuardianRegistrationEmail({
      to: guardian.email,
      guardianName: guardian.fullName,
      email: guardian.email,
      password,
      loginLink: buildGuardianLoginLink(),
      studentName: student.name,
      relation: input.relation,
    });
  } catch (error) {
    // The account is created; surface a soft warning but do not roll back.
    console.error("Failed to send guardian registration email:", error);
  }

  return { guardian, relation: input.relation };
}

export async function searchGuardians(query: string) {
  const q = query.trim();

  const guardians = await prisma.guardian.findMany({
    where: {
      OR: [
        { fullName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: { fullName: "asc" },
    take: 10,
    select: guardianPublicSelect,
  });

  return guardians;
}

export async function linkGuardianToStudent(
  teacherId: string,
  input: LinkGuardianInput
) {
  await assertTeacherCanManageStudent(teacherId, input.studentId);

  const guardian = await prisma.guardian.findUnique({
    where: { id: input.guardianId },
    select: { id: true },
  });

  if (!guardian) {
    throw new AppError("Guardian not found.", 404, "GUARDIAN_NOT_FOUND");
  }

  try {
    await prisma.guardianStudent.create({
      data: {
        guardianId: input.guardianId,
        studentId: input.studentId,
        relation: input.relation,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError(
        "This guardian is already linked to this student.",
        409,
        "ALREADY_LINKED"
      );
    }
    throw error;
  }

  return { success: true };
}

export async function unlinkGuardianFromStudent(
  teacherId: string,
  guardianId: string,
  studentId: string
) {
  await assertTeacherCanManageStudent(teacherId, studentId);

  await prisma.guardianStudent.deleteMany({
    where: { guardianId, studentId },
  });

  return { success: true };
}

export async function updateGuardianLinkRelation(
  teacherId: string,
  guardianId: string,
  input: UpdateGuardianLinkInput
) {
  await assertTeacherCanManageStudent(teacherId, input.studentId);

  const result = await prisma.guardianStudent.updateMany({
    where: { guardianId, studentId: input.studentId },
    data: { relation: input.relation },
  });

  if (result.count === 0) {
    throw new AppError("Guardian link not found.", 404, "LINK_NOT_FOUND");
  }

  return { success: true };
}

/**
 * Teacher edits the shared guardian account. Allowed only when the teacher
 * shares at least one student with that guardian.
 */
export async function updateGuardianDetails(
  teacherId: string,
  guardianId: string,
  input: UpdateGuardianDetailsInput
) {
  const shared = await prisma.guardianStudent.findFirst({
    where: {
      guardianId,
      student: {
        OR: [
          { teacherId },
          { classes: { some: { isActive: true, class: { teacherId } } } },
        ],
      },
    },
    select: { id: true },
  });

  if (!shared) {
    throw new AppError(
      "You cannot edit this guardian.",
      403,
      "GUARDIAN_NOT_ACCESSIBLE"
    );
  }

  await assertEmailAvailable(input.email, { guardianId });

  const nameTaken = await prisma.guardian.findFirst({
    where: { fullName: input.fullName, NOT: { id: guardianId } },
    select: { id: true },
  });

  if (nameTaken) {
    throw new AppError(
      "Another guardian already uses this full name.",
      409,
      "GUARDIAN_NAME_EXISTS"
    );
  }

  const guardian = await prisma.guardian.update({
    where: { id: guardianId },
    data: {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
    },
    select: guardianPublicSelect,
  });

  return guardian;
}

export async function listStudentGuardians(teacherId: string, studentId: string) {
  await assertTeacherCanManageStudent(teacherId, studentId);

  const links = await prisma.guardianStudent.findMany({
    where: { studentId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      relation: true,
      createdAt: true,
      guardian: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  return links.map((link) => ({
    linkId: link.id,
    guardianId: link.guardian.id,
    fullName: link.guardian.fullName,
    email: link.guardian.email,
    phone: link.guardian.phone,
    relation: link.relation,
    createdAt: link.createdAt,
  }));
}
