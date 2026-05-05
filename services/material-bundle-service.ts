import { AppError } from "@/lib/error-handler";
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
      class: {
        teacherId,
      },
    },
    select: {
      id: true,
      classId: true,
      status: true,
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
      bundle: {
        class: {
          teacherId,
        },
      },
    },
    select: {
      id: true,
      bundleId: true,
      type: true,
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
        status: true,
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
            items: true,
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
      status: true,
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
    },
    select: {
      id: true,
      classId: true,
      title: true,
      year: true,
      month: true,
      status: true,
      sentAt: true,
      createdAt: true,
    },
  });
}

export async function deleteMaterialBundleForTeacher(teacherId: string, bundleId: string) {
  await assertTeacherOwnsBundle(teacherId, bundleId);

  await prisma.materialBundle.delete({
    where: {
      id: bundleId,
    },
  });
}

export async function getMaterialBundleDetailsForTeacher(teacherId: string, bundleId: string) {
  const bundle = await prisma.materialBundle.findFirst({
    where: {
      id: bundleId,
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
      status: true,
      sentAt: true,
      createdAt: true,
      class: {
        select: {
          id: true,
          name: true,
          students: {
            where: { isActive: true },
            select: {
              student: {
                select: {
                  id: true,
                  name: true,
                  registrationNumber: true,
                },
              },
            },
          },
        },
      },
      items: {
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

  const recipientsMap = new Map(
    bundle.recipients.map((r) => [
      r.studentId,
      {
        willReceive: r.willReceive,
        receivedAt: r.receivedAt,
      },
    ])
  );

  const students = bundle.class.students.map((entry) => {
    const student = entry.student;
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
    status: bundle.status,
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
  input: UpdateMaterialBundleItemInput
) {
  const item = await assertTeacherOwnsBundleItem(teacherId, bundleId, itemId);

  if (item.type !== "PAPER" && (input.paperStartAt !== undefined || input.paperEndAt !== undefined)) {
    throw new AppError("Only paper items can have start/end times.", 400, "VALIDATION_ERROR");
  }

  return prisma.materialBundleItem.update({
    where: {
      id: itemId,
    },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.paperStartAt !== undefined ? { paperStartAt: input.paperStartAt } : {}),
      ...(input.paperEndAt !== undefined ? { paperEndAt: input.paperEndAt } : {}),
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

export async function deleteMaterialBundleItemForTeacher(teacherId: string, bundleId: string, itemId: string) {
  await assertTeacherOwnsBundleItem(teacherId, bundleId, itemId);

  await prisma.materialBundleItem.delete({
    where: {
      id: itemId,
    },
  });
}

export async function saveMaterialBundleRecipientsForTeacher(
  teacherId: string,
  bundleId: string,
  input: SaveMaterialBundleRecipientsInput
) {
  const bundle = await assertTeacherOwnsBundle(teacherId, bundleId);

  const classStudents = await prisma.classStudent.findMany({
    where: {
      classId: bundle.classId,
      isActive: true,
    },
    select: {
      studentId: true,
    },
  });

  const classStudentIds = new Set(classStudents.map((s) => s.studentId));

  for (const id of input.selectedStudentIds) {
    if (!classStudentIds.has(id)) {
      throw new AppError("One or more selected students are not in this class.", 400, "VALIDATION_ERROR");
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const classStudent of classStudents) {
      const willReceive = input.selectedStudentIds.includes(classStudent.studentId);

      await tx.materialBundleRecipient.upsert({
        where: {
          bundleId_studentId: {
            bundleId,
            studentId: classStudent.studentId,
          },
        },
        create: {
          bundleId,
          studentId: classStudent.studentId,
          willReceive,
          receivedAt: null,
        },
        update: {
          willReceive,
          receivedAt: null,
        },
      });
    }

    await tx.materialBundle.update({
      where: {
        id: bundleId,
      },
      data: {
        status: "SENT",
        sentAt: new Date(),
      },
    });
  });

  return getMaterialBundleDetailsForTeacher(teacherId, bundleId);
}
