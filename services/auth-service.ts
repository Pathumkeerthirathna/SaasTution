import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { StudentConfirmationStatus, type Role } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { buildPasswordResetLink, sendPasswordResetEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { defaultProfileSectionsCreateInput } from "@/services/teacher-profile-section-service";

const HASH_ROUNDS = 12;
const PASSWORD_RESET_TTL_MINUTES = 30;

export type LoginUser = {
  id: string;
  name: string;
  email: string;
};

export type LoginResult =
  | {
      user: LoginUser;
      role: "TEACHER";
      redirectTo: "/dashboard";
    }
  | {
      user: LoginUser;
      role: "STUDENT";
      redirectTo: "/student/dashboard";
      studentStatus: {
        isActive: boolean;
        isConfirmed: boolean;
      };
    };

type PasswordOwnerRole = "TEACHER" | "STUDENT" | "GUARDIAN";

function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createRawResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function createPasswordResetToken(params: {
  role: Role;
  userId: string;
  email: string;
}) {
  const rawToken = createRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: {
      tokenHash,
      role: params.role,
      userId: params.userId,
      email: params.email,
      expiresAt,
    },
  });

  return rawToken;
}

export async function findTeacherByEmail(email: string) {
  return prisma.teacher.findUnique({
    where: { email },
  });
}

export async function findStudentByRegistrationNumber(registrationNumber: string) {
  return prisma.student.findFirst({
    where: {
      registrationNumber: registrationNumber.toUpperCase(),
    },
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
      profileSections: defaultProfileSectionsCreateInput(),
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

export async function loginStudent(registrationNumber: string, password: string) {

  const student = await findStudentByRegistrationNumber(registrationNumber);

  if (!student || !student.password || !student.email) {
    throw new AppError("Invalid registration number or password. If you are new click forogt password and reset the password first", 401, "INVALID_CREDENTIALS");
  }

  const isPasswordValid = await bcrypt.compare(password, student.password);

  if (!isPasswordValid) {
    throw new AppError("Invalid registration number or password.", 401, "INVALID_CREDENTIALS");
  }

  if (student.confirmationStatus === StudentConfirmationStatus.PENDING) {
    const profile = await prisma.teacherProfile.findUnique({
      where: { teacherId: student.teacherId },
      select: {
        phone: true,
        whatsapp: true,
        teacher: { select: { name: true } },
      },
    });

    throw new AppError(
      "Your registration is waiting for your teacher's approval. You'll be able to sign in once they confirm it.",
      403,
      "STUDENT_PENDING_APPROVAL",
      {
        teacherName: profile?.teacher.name ?? null,
        phone: profile?.phone ?? null,
        whatsapp: profile?.whatsapp ?? null,
      }
    );
  }

  if (student.confirmationStatus === StudentConfirmationStatus.REJECTED) {
    throw new AppError(
      "Your registration was not approved. Please contact your teacher for help.",
      403,
      "STUDENT_REGISTRATION_REJECTED"
    );
  }

  if (student.status === 1) {
    const profile = await prisma.teacherProfile.findUnique({
      where: { teacherId: student.teacherId },
      select: {
        phone: true,
        whatsapp: true,
        teacher: { select: { name: true } },
      },
    });

    throw new AppError(
      student.deactivationReason
        ? `Your teacher has deactivated your account. Reason: ${student.deactivationReason}`
        : "Your teacher has deactivated your account.",
      403,
      "STUDENT_DEACTIVATED",
      {
        reason: student.deactivationReason ?? null,
        teacherName: profile?.teacher.name ?? null,
        phone: profile?.phone ?? null,
        whatsapp: profile?.whatsapp ?? null,
      }
    );
  }

  return {
    id: student.id,
    name: student.name,
    email: student.email,
    createdAt: student.createdAt,
    confirmationStatus:student.confirmationStatus,
    status:student.status
  };
}

export async function loginByLoginId(loginId: string, password: string): Promise<LoginResult> {
  const normalized = loginId.trim();
  const maybeEmail = normalized.toLowerCase();

  const teacher = await findTeacherByEmail(maybeEmail);

  if (teacher) {
    const authenticatedTeacher = await loginTeacher(maybeEmail, password);
    return {
      role: "TEACHER",
      redirectTo: "/dashboard",
      user: {
        id: authenticatedTeacher.id,
        name: authenticatedTeacher.name,
        email: authenticatedTeacher.email,
      },
    };
  }

  const authenticatedStudent = await loginStudent(normalized, password);
  return {
    role: "STUDENT",
    redirectTo: "/student/dashboard",
    user: {
      id: authenticatedStudent.id,
      name: authenticatedStudent.name,
      email: authenticatedStudent.email,
    },
    studentStatus:{
      isActive:authenticatedStudent.status==0?true:false,
      isConfirmed:authenticatedStudent.confirmationStatus==StudentConfirmationStatus.APPROVED?true:false
    }
  };
}

export async function requestPasswordReset(loginId: string, appBaseUrl?: string) {
  const normalized = loginId.trim();
  const maybeEmail = normalized.toLowerCase();

  const teacher = await prisma.teacher.findUnique({
    where: {
      email: maybeEmail,
    },
    select: {
      id: true,
      email: true,
    },
  });

  if (teacher) {
    const token = await createPasswordResetToken({
      role: "TEACHER",
      userId: teacher.id,
      email: teacher.email,
    });

    await sendPasswordResetEmail({
      to: teacher.email,
      resetLink: buildPasswordResetLink(token, appBaseUrl),
    });
    return;
  }

  const guardian = await prisma.guardian.findFirst({
    where: {
      email: maybeEmail,
    },
    select: {
      id: true,
      email: true,
    },
  });

  if (guardian?.email) {
    const token = await createPasswordResetToken({
      role: "GUARDIAN",
      userId: guardian.id,
      email: guardian.email,
    });

    await sendPasswordResetEmail({
      to: guardian.email,
      resetLink: buildPasswordResetLink(token, appBaseUrl),
    });
    return;
  }

  const student = await prisma.student.findFirst({
    where: {
      OR: [
        {
          registrationNumber: normalized.toUpperCase(),
        },
        {
          email: maybeEmail,
        },
      ],
    },
    select: {
      id: true,
      email: true,
    },
  });

  if (student?.email) {
    const token = await createPasswordResetToken({
      role: "STUDENT",
      userId: student.id,
      email: student.email,
    });

    await sendPasswordResetEmail({
      to: student.email,
      resetLink: buildPasswordResetLink(token, appBaseUrl),
    });
  }
}

export async function confirmPasswordReset(token: string, newPassword: string) {
  const tokenHash = hashResetToken(token.trim());
  const resetRecord = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
    select: {
      id: true,
      role: true,
      userId: true,
    },
  });

  if (!resetRecord) {
    throw new AppError("Reset link is invalid or expired.", 400, "INVALID_RESET_TOKEN");
  }

  const passwordHash = await bcrypt.hash(newPassword, HASH_ROUNDS);

  await prisma.$transaction(async (tx) => {
    if (resetRecord.role === "TEACHER") {
      await tx.teacher.update({
        where: { id: resetRecord.userId },
        data: { password: passwordHash },
      });
    } else if (resetRecord.role === "STUDENT") {
      await tx.student.update({
        where: { id: resetRecord.userId },
        data: { password: passwordHash },
      });
    } else if (resetRecord.role === "GUARDIAN") {
      await tx.guardian.update({
        where: { id: resetRecord.userId },
        data: { password: passwordHash },
      });
    } else {
      throw new AppError("Password reset is not supported for this role.", 400, "ROLE_NOT_SUPPORTED");
    }

    await tx.passwordResetToken.update({
      where: { id: resetRecord.id },
      data: { usedAt: new Date() },
    });
  });
}

export async function updatePasswordForAuthenticatedUser(input: {
  role: PasswordOwnerRole;
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  const passwordHash = await bcrypt.hash(input.newPassword, HASH_ROUNDS);

  if (input.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { id: input.userId },
      select: { password: true },
    });

    if (!teacher) {
      throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    }

    const passwordMatches = await bcrypt.compare(input.currentPassword, teacher.password);

    if (!passwordMatches) {
      throw new AppError("Current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
    }

    await prisma.teacher.update({
      where: { id: input.userId },
      data: { password: passwordHash },
    });
    return;
  }

  if (input.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { id: input.userId },
      select: { password: true },
    });

    if (!student || !student.password) {
      throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    }

    const passwordMatches = await bcrypt.compare(input.currentPassword, student.password);

    if (!passwordMatches) {
      throw new AppError("Current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
    }

    await prisma.student.update({
      where: { id: input.userId },
      data: { password: passwordHash },
    });
    return;
  }

  const guardian = await prisma.guardian.findUnique({
    where: { id: input.userId },
    select: { password: true },
  });

  if (!guardian || !guardian.password) {
    throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  }

  const passwordMatches = await bcrypt.compare(input.currentPassword, guardian.password);

  if (!passwordMatches) {
    throw new AppError("Current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
  }

  await prisma.guardian.update({
    where: { id: input.userId },
    data: { password: passwordHash },
  });
}
