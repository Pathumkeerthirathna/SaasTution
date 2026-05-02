import bcrypt from "bcryptjs";

import type { GuardianLoginInput, GuardianRegisterInput } from "@/lib/guardian-validation";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

const HASH_ROUNDS = 12;

export async function registerGuardianAccount(input: GuardianRegisterInput) {
  const existingEmail = await prisma.guardian.findFirst({
    where: {
      email: input.email,
    },
    select: {
      id: true,
    },
  });

  if (existingEmail) {
    throw new AppError("Email is already registered.", 409, "EMAIL_ALREADY_EXISTS");
  }

  const guardian = await prisma.guardian.findUnique({
    where: {
      id: input.guardianId,
    },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
    },
  });

  if (!guardian) {
    throw new AppError("Guardian profile not found.", 404, "GUARDIAN_NOT_FOUND");
  }

  if (guardian.phone !== input.phone) {
    throw new AppError("Phone number does not match this guardian profile.", 400, "PHONE_MISMATCH");
  }

  if (guardian.email) {
    throw new AppError("Guardian account is already registered.", 409, "ACCOUNT_ALREADY_REGISTERED");
  }

  const passwordHash = await bcrypt.hash(input.password, HASH_ROUNDS);

  return prisma.guardian.update({
    where: {
      id: input.guardianId,
    },
    data: {
      email: input.email,
      password: passwordHash,
    },
    select: {
      id: true,
      name: true,
      relation: true,
      phone: true,
      email: true,
      studentId: true,
    },
  });
}

export async function loginGuardian(input: GuardianLoginInput) {
  const guardian = await prisma.guardian.findFirst({
    where: {
      email: input.email,
    },
    select: {
      id: true,
      name: true,
      relation: true,
      phone: true,
      email: true,
      studentId: true,
      password: true,
    },
  });

  if (!guardian || !guardian.password) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  const passwordMatches = await bcrypt.compare(input.password, guardian.password);

  if (!passwordMatches) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  return {
    id: guardian.id,
    name: guardian.name,
    relation: guardian.relation,
    phone: guardian.phone,
    email: guardian.email,
    studentId: guardian.studentId,
  };
}

export async function getGuardianStudentOverview(guardianId: string) {
  const guardian = await prisma.guardian.findUnique({
    where: {
      id: guardianId,
    },
    select: {
      id: true,
      name: true,
      relation: true,
      phone: true,
      email: true,
      student: {
        select: {
          id: true,
          name: true,
          grade: true,
          contact: true,
          classes: {
            select: {
              class: {
                select: {
                  id: true,
                  name: true,
                  schedule: true,
                  description: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!guardian) {
    throw new AppError("Guardian profile not found.", 404, "GUARDIAN_NOT_FOUND");
  }

  return {
    guardian: {
      id: guardian.id,
      name: guardian.name,
      relation: guardian.relation,
      phone: guardian.phone,
      email: guardian.email,
    },
    student: {
      id: guardian.student.id,
      name: guardian.student.name,
      grade: guardian.student.grade,
      contact: guardian.student.contact,
      classes: guardian.student.classes.map((entry) => entry.class),
    },
  };
}
