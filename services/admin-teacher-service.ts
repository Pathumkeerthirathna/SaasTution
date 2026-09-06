import { AppError } from "@/lib/error-handler";
import { buildTeacherLoginLink, sendTeacherAccountConfirmedEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getCurrentTeacherSubscription } from "@/services/teacher-subscription-service";

export type TeacherRegistrationDateFilter = "ALL" | "MONTH" | "QUARTER" | "YEAR";

function dateFilterRange(filter: TeacherRegistrationDateFilter) {
  if (filter === "ALL") {
    return null;
  }

  const now = new Date();

  if (filter === "MONTH") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { gte: start, lt: end };
  }

  if (filter === "QUARTER") {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    const start = new Date(now.getFullYear(), quarterStartMonth, 1);
    const end = new Date(now.getFullYear(), quarterStartMonth + 3, 1);
    return { gte: start, lt: end };
  }

  // YEAR
  const start = new Date(now.getFullYear(), 0, 1);
  const end = new Date(now.getFullYear() + 1, 0, 1);
  return { gte: start, lt: end };
}

export async function listTeacherAccountsForAdmin(params: {
  skip: number;
  take: number;
  search?: string;
  dateFilter?: TeacherRegistrationDateFilter;
}) {
  const where: Prisma.TeacherWhereInput = {};

  const search = params.search?.trim();

  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  const range = dateFilterRange(params.dateFilter ?? "ALL");

  if (range) {
    where.createdAt = range;
  }

  const [teachers, totalItems] = await Promise.all([
    prisma.teacher.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        contact: true,
        createdAt: true,
        isConfirmed: true,
        confirmedAt: true,
        isRejected: true,
        rejectedAt: true,
        isBlocked: true,
        blockedAt: true,
        blockReason: true,
        _count: {
          select: { classes: true },
        },
      },
    }),
    prisma.teacher.count({ where }),
  ]);

  return {
    totalItems,
    teachers: teachers.map((teacher) => ({
      id: teacher.id,
      name: teacher.name,
      email: teacher.email,
      contact: teacher.contact,
      createdAt: teacher.createdAt,
      isConfirmed: teacher.isConfirmed,
      confirmedAt: teacher.confirmedAt,
      isRejected: teacher.isRejected,
      rejectedAt: teacher.rejectedAt,
      isBlocked: teacher.isBlocked,
      blockedAt: teacher.blockedAt,
      blockReason: teacher.blockReason,
      classCount: teacher._count.classes,
    })),
  };
}

async function findTeacherOrThrow(teacherId: string) {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { id: true },
  });

  if (!teacher) {
    throw new AppError("Teacher not found.", 404, "TEACHER_NOT_FOUND");
  }
}

export async function confirmTeacherAccount(teacherId: string) {
  await findTeacherOrThrow(teacherId);

  const updated = await prisma.teacher.update({
    where: { id: teacherId },
    data: {
      isConfirmed: true,
      confirmedAt: new Date(),
      isRejected: false,
      rejectedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      isConfirmed: true,
      confirmedAt: true,
      isRejected: true,
      rejectedAt: true,
    },
  });

  try {
    const subscription = await getCurrentTeacherSubscription(teacherId);

    await sendTeacherAccountConfirmedEmail({
      to: updated.email,
      teacherName: updated.name,
      planName: subscription?.plan.name ?? null,
      planPrice: subscription
        ? `${subscription.currency} ${subscription.price.toLocaleString()}`
        : null,
      planInterval: subscription
        ? subscription.plan.interval === "MONTHLY"
          ? "month"
          : "year"
        : null,
      loginLink: buildTeacherLoginLink(),
    });
  } catch (error) {
    // The account is still confirmed even if the congratulations email fails.
    console.error("Failed to email teacher about account confirmation:", error);
  }

  return updated;
}

export async function rejectTeacherAccount(teacherId: string) {
  await findTeacherOrThrow(teacherId);

  return prisma.teacher.update({
    where: { id: teacherId },
    data: {
      isConfirmed: false,
      confirmedAt: null,
      isRejected: true,
      rejectedAt: new Date(),
    },
    select: {
      id: true,
      isConfirmed: true,
      confirmedAt: true,
      isRejected: true,
      rejectedAt: true,
    },
  });
}

export async function blockTeacherAccount(
  teacherId: string,
  reason: string
) {
  await findTeacherOrThrow(teacherId);

  const trimmedReason = reason.trim();

  if (!trimmedReason) {
    throw new AppError(
      "Please provide a reason for blocking this teacher.",
      400,
      "VALIDATION_ERROR"
    );
  }

  return prisma.teacher.update({
    where: { id: teacherId },
    data: {
      isBlocked: true,
      blockedAt: new Date(),
      blockReason: trimmedReason,
    },
    select: {
      id: true,
      isBlocked: true,
      blockedAt: true,
      blockReason: true,
    },
  });
}

export async function unblockTeacherAccount(teacherId: string) {
  await findTeacherOrThrow(teacherId);

  return prisma.teacher.update({
    where: { id: teacherId },
    data: {
      isBlocked: false,
      blockedAt: null,
      blockReason: null,
    },
    select: {
      id: true,
      isBlocked: true,
      blockedAt: true,
      blockReason: true,
    },
  });
}
