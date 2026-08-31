import { AppError } from "@/lib/error-handler";
import { removeBundleItemFile } from "@/lib/material-bundle-file";
import { prisma } from "@/lib/prisma";
import type {
  CreateMaterialBundleInput,
  CreateMaterialBundleItemInput,
  SaveMaterialBundleRecipientsInput,
  UpdateMaterialBundleInput,
  UpdateMaterialBundleItemInput,
} from "@/lib/material-bundle-validation";

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
    },
  });

  if (!classroom) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return classroom;
}

async function assertTeacherOwnsBundle(teacherId: string, bundleId: string) {
  const bundle = await prisma.materialBundle.findFirst({
    where: {
      id: bundleId,
      status: 0,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
      bundleStatus: true,
    },
  });

  if (!bundle) {
    throw new AppError("Bundle not found.", 404, "BUNDLE_NOT_FOUND");
  }

  return bundle;
}

async function assertTeacherOwnsBundleItem(teacherId: string, bundleId: string, itemId: string) {
  const item = await prisma.materialBundleItem.findFirst({
    where: {
      id: itemId,
      bundleId,
      status: 0,
      bundle: {
        status: 0,
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      bundleId: true,
      type: true,
      fileUrl: true,
    },
  });

  if (!item) {
    throw new AppError("Bundle item not found.", 404, "BUNDLE_ITEM_NOT_FOUND");
  }

  return item;
}

export async function listMaterialBundlesForTeacher(params: {
  teacherId: string;
  classId?: string;
  year?: number;
  month?: number;
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
    },
    ...(params.classId ? { classId: params.classId } : {}),
    ...(params.year !== undefined ? { year: params.year } : {}),
    ...(params.month !== undefined ? { month: params.month } : {}),
  };

  const [bundles, totalItems] = await Promise.all([
    prisma.materialBundle.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        classId: true,
        title: true,
        year: true,
        month: true,
        bundleStatus: true,
        sentAt: true,
        createdAt: true,
        class: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: {
            items: { where: { status: 0 } },
            recipients: true,
          },
        },
      },
    }),
    prisma.materialBundle.count({ where }),
  ]);

  return {
    bundles,
    totalItems,
  };
}

/**
 * Students active in a class during a given month — used by the create-bundle
 * flow so the teacher can pick recipients before the bundle exists.
 */
export async function listActiveClassStudentsForMonthForTeacher(params: {
  teacherId: string;
  classId: string;
  year: number;
  month: number;
}) {
  await assertTeacherOwnsClass(params.teacherId, params.classId);

  const monthStart = new Date(params.year, params.month - 1, 1);
  const monthEnd = new Date(params.year, params.month, 0, 23, 59, 59, 999);

  const rows = await prisma.classStudent.findMany({
    where: {
      classId: params.classId,
      student: { status: 0 },
      assignedAt: { lte: monthEnd },
      OR: [{ removedAt: null }, { removedAt: { gte: monthStart } }],
    },
    orderBy: { student: { name: "asc" } },
    select: {
      student: {
        select: {
          id: true,
          name: true,
          registrationNumber: true,
        },
      },
    },
  });

  const unique = new Map(rows.map((r) => [r.student.id, r.student]));
  return [...unique.values()];
}

export async function createMaterialBundleForTeacher(teacherId: string, input: CreateMaterialBundleInput) {
  await assertTeacherOwnsClass(teacherId, input.classId);

  return prisma.materialBundle.create({
    data: {
      classId: input.classId,
      title: input.title,
      year: input.year,
      month: input.month,
    },
    select: {
      id: true,
      classId: true,
      title: true,
      year: true,
      month: true,
      bundleStatus: true,
      sentAt: true,
      createdAt: true,
    },
  });
}

export async function updateMaterialBundleForTeacher(
  teacherId: string,
  bundleId: string,
  input: UpdateMaterialBundleInput
) {
  await assertTeacherOwnsBundle(teacherId, bundleId);

  return prisma.materialBundle.update({
    where: {
      id: bundleId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.year !== undefined ? { year: input.year } : {}),
      ...(input.month !== undefined ? { month: input.month } : {}),
      ...(input.bundleStatus !== undefined
        ? {
            bundleStatus: input.bundleStatus,
            sentAt: input.bundleStatus === "SENT" ? new Date() : null,
          }
        : {}),
    },
    select: {
      id: true,
      classId: true,
      title: true,
      year: true,
      month: true,
      bundleStatus: true,
      sentAt: true,
      createdAt: true,
    },
  });
}

export async function deleteMaterialBundleForTeacher(teacherId: string, bundleId: string) {
  await assertTeacherOwnsBundle(teacherId, bundleId);

  // Soft delete: status 1 hides the bundle (and its items) everywhere while
  // keeping the row and its files intact.
  await prisma.materialBundle.update({
    where: {
      id: bundleId,
    },
    data: {
      status: 1,
    },
  });
}

export async function getMaterialBundleDetailsForTeacher(teacherId: string, bundleId: string) {
  const bundle = await prisma.materialBundle.findFirst({
    where: {
      id: bundleId,
      status: 0,
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
      title: true,
      year: true,
      month: true,
      bundleStatus: true,
      sentAt: true,
      createdAt: true,
      class: {
        select: {
          id: true,
          name: true,
        },
      },
      items: {
        where: { status: 0 },
        orderBy: [{ type: "asc" }, { createdAt: "desc" }],
        select: {
          id: true,
          type: true,
          title: true,
          description: true,
          fileName: true,
          fileUrl: true,
          mimeType: true,
          sizeBytes: true,
          paperStartAt: true,
          paperEndAt: true,
          createdAt: true,
        },
      },
      recipients: {
        orderBy: {
          student: {
            name: "asc",
          },
        },
        select: {
          studentId: true,
          willReceive: true,
          receivedAt: true,
        },
      },
    },
  });

  if (!bundle) {
    throw new AppError("Bundle not found.", 404, "BUNDLE_NOT_FOUND");
  }

  // Students who were active in this class during the bundle's month: assigned
  // on or before the month ends and not removed before the month begins.
  const monthStart = new Date(bundle.year, bundle.month - 1, 1);
  const monthEnd = new Date(bundle.year, bundle.month, 0, 23, 59, 59, 999);

  const classStudents = await prisma.classStudent.findMany({
    where: {
      classId: bundle.classId,
      student: { status: 0 },
      assignedAt: { lte: monthEnd },
      OR: [{ removedAt: null }, { removedAt: { gte: monthStart } }],
    },
    orderBy: { student: { name: "asc" } },
    select: {
      student: {
        select: {
          id: true,
          name: true,
          registrationNumber: true,
        },
      },
    },
  });

  // De-duplicate in case a student has multiple enrolment rows in the window.
  const uniqueStudents = new Map(
    classStudents.map((entry) => [entry.student.id, entry.student])
  );

  const recipientsMap = new Map(
    bundle.recipients.map((r) => [
      r.studentId,
      {
        willReceive: r.willReceive,
        receivedAt: r.receivedAt,
      },
    ])
  );

  const students = [...uniqueStudents.values()].map((student) => {
    const recipientState = recipientsMap.get(student.id);
    const willReceive = recipientState?.willReceive ?? false;

    return {
      id: student.id,
      name: student.name,
      registrationNumber: student.registrationNumber,
      willReceive,
      receivedAt: willReceive ? (recipientState?.receivedAt ?? null) : null,
    };
  });

  return {
    id: bundle.id,
    classId: bundle.classId,
    className: bundle.class.name,
    title: bundle.title,
    year: bundle.year,
    month: bundle.month,
    bundleStatus: bundle.bundleStatus,
    sentAt: bundle.sentAt,
    createdAt: bundle.createdAt,
    items: bundle.items,
    students,
    hasRecipientSelections: bundle.recipients.length > 0,
    summary: {
      totalStudents: students.length,
      willReceiveCount: students.filter((s) => s.willReceive).length,
      willNotReceiveCount: students.filter((s) => !s.willReceive).length,
    },
  };
}

export async function addMaterialBundleItemForTeacher(params: {
  teacherId: string;
  bundleId: string;
  input: CreateMaterialBundleItemInput;
  file?: {
    fileName: string;
    fileUrl: string;
    mimeType: string;
    sizeBytes: number;
  };
}) {
  await assertTeacherOwnsBundle(params.teacherId, params.bundleId);

  return prisma.materialBundleItem.create({
    data: {
      bundleId: params.bundleId,
      type: params.input.type,
      title: params.input.title,
      description: params.input.description,
      fileName: params.file?.fileName,
      fileUrl: params.file?.fileUrl,
      mimeType: params.file?.mimeType,
      sizeBytes: params.file?.sizeBytes,
      paperStartAt: params.input.paperStartAt,
      paperEndAt: params.input.paperEndAt,
    },
    select: {
      id: true,
      bundleId: true,
      type: true,
      title: true,
      description: true,
      fileName: true,
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      paperStartAt: true,
      paperEndAt: true,
      createdAt: true,
    },
  });
}

export async function updateMaterialBundleItemForTeacher(
  teacherId: string,
  bundleId: string,
  itemId: string,
  input: UpdateMaterialBundleItemInput,
  file?: {
    fileName: string;
    fileUrl: string;
    mimeType: string;
    sizeBytes: number;
  }
) {
  const item = await assertTeacherOwnsBundleItem(teacherId, bundleId, itemId);

  if (item.type !== "PAPER" && (input.paperStartAt !== undefined || input.paperEndAt !== undefined)) {
    throw new AppError("Only paper items can have start/end times.", 400, "VALIDATION_ERROR");
  }

  const updated = await prisma.materialBundleItem.update({
    where: {
      id: itemId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.paperStartAt !== undefined ? { paperStartAt: input.paperStartAt } : {}),
      ...(input.paperEndAt !== undefined ? { paperEndAt: input.paperEndAt } : {}),
      ...(file
        ? {
            fileName: file.fileName,
            fileUrl: file.fileUrl,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          }
        : {}),
    },
    select: {
      id: true,
      bundleId: true,
      type: true,
      title: true,
      description: true,
      fileName: true,
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      paperStartAt: true,
      paperEndAt: true,
      createdAt: true,
    },
  });

  if (file && item.fileUrl && item.fileUrl !== updated.fileUrl) {
    await removeBundleItemFile(item.fileUrl);
  }

  return updated;
}

export async function deleteMaterialBundleItemForTeacher(teacherId: string, bundleId: string, itemId: string) {
  await assertTeacherOwnsBundleItem(teacherId, bundleId, itemId);

  // Soft delete — keep the row, its file, and any submissions.
  await prisma.materialBundleItem.update({
    where: {
      id: itemId,
    },
    data: {
      status: 1,
    },
  });
}

export async function saveMaterialBundleRecipientsForTeacher(
  teacherId: string,
  bundleId: string,
  input: SaveMaterialBundleRecipientsInput
) {
  await assertTeacherOwnsBundle(teacherId, bundleId);

  const bundle = await prisma.materialBundle.findUniqueOrThrow({
    where: { id: bundleId },
    select: { classId: true, year: true, month: true },
  });

  const monthStart = new Date(bundle.year, bundle.month - 1, 1);
  const monthEnd = new Date(bundle.year, bundle.month, 0, 23, 59, 59, 999);

  const classStudentRows = await prisma.classStudent.findMany({
    where: {
      classId: bundle.classId,
      assignedAt: { lte: monthEnd },
      OR: [{ removedAt: null }, { removedAt: { gte: monthStart } }],
    },
    select: {
      studentId: true,
    },
  });

  const classStudentIds = [
    ...new Set(classStudentRows.map((s) => s.studentId)),
  ];
  const classStudentIdSet = new Set(classStudentIds);

  for (const id of input.selectedStudentIds) {
    if (!classStudentIdSet.has(id)) {
      throw new AppError("One or more selected students are not in this class for this month.", 400, "VALIDATION_ERROR");
    }
  }

  const selectedStudentIdSet = new Set(input.selectedStudentIds);

  // Rebuild the recipient set in a few bulk queries instead of one upsert per
  // student — a per-student loop blew past the 5s interactive transaction
  // timeout for larger classes.
  await prisma.$transaction(async (tx) => {
    await tx.materialBundleRecipient.deleteMany({ where: { bundleId } });

    if (classStudentIds.length > 0) {
      await tx.materialBundleRecipient.createMany({
        data: classStudentIds.map((studentId) => ({
          bundleId,
          studentId,
          willReceive: selectedStudentIdSet.has(studentId),
        })),
      });
    }

    await tx.materialBundle.update({
      where: {
        id: bundleId,
      },
      data: {
        bundleStatus: "SENT",
        sentAt: new Date(),
      },
    });
  });

  return getMaterialBundleDetailsForTeacher(teacherId, bundleId);
}
