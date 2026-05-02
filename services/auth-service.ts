import bcrypt from "bcryptjs";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

const HASH_ROUNDS = 12;

export async function findTeacherByEmail(email: string) {
  return prisma.teacher.findUnique({
    where: { email },
  });
}

export async function registerTeacher(input: {
  name: string;
  email: string;
  password: string;
}) {
  const existingTeacher = await findTeacherByEmail(input.email);

  if (existingTeacher) {
    throw new AppError(
      "A teacher account already exists with this email.",
      409,
      "EMAIL_ALREADY_EXISTS"
    );
  }

  const hashedPassword = await bcrypt.hash(input.password, HASH_ROUNDS);

  return prisma.teacher.create({
    data: {
      name: input.name,
      email: input.email,
      password: hashedPassword,
    },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
    },
  });
}

export async function loginTeacher(email: string, password: string) {
  const teacher = await findTeacherByEmail(email);

  if (!teacher) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  const isPasswordValid = await bcrypt.compare(password, teacher.password);

  if (!isPasswordValid) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  return {
    id: teacher.id,
    name: teacher.name,
    email: teacher.email,
    createdAt: teacher.createdAt,
  };
}
