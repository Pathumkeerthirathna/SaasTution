import { AppError } from "@/lib/error-handler";
import { sendClassAnnouncementEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { getMessagingProvider } from "@/services/messaging-provider";

const DELIVERY_STATUS = {
  QUEUED: "QUEUED",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;

async function assertTeacherOwnsClass(classId: string, teacherId: string) {
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

export async function sendMessageToClassStudents(params: {
  teacherId: string;
  classId: string;
  content: string;
  channel?: "email" | "whatsapp";
}) {
  const channel = params.channel ?? "email";
  const classroom = await assertTeacherOwnsClass(params.classId, params.teacherId);

  if (channel === "whatsapp") {
    const classStudents = await prisma.classStudent.findMany({
      where: { classId: params.classId, isActive: true, student: { status: 0 } },
      select: { student: { select: { id: true, contact: true } } },
    });

    const recipients = classStudents.map((entry) => ({
      studentId: entry.student.id,
      contact: entry.student.contact,
    }));

    const savedMessage = await prisma.message.create({
      data: {
        classId: params.classId,
        content: params.content,
        deliveries: {
          createMany: {
            data: recipients.map((recipient) => ({
              studentId: recipient.studentId,
              status: DELIVERY_STATUS.QUEUED,
              provider: "whatsapp",
            })),
          },
        },
      },
      select: { id: true, classId: true, content: true, createdAt: true },
    });

    return {
      message: savedMessage,
      delivery: {
        provider: "whatsapp",
        delivered: 0,
        failed: 0,
        queued: recipients.length,
      },
      totalRecipients: recipients.length,
      whatsappUrl: `https://wa.me/?text=${encodeURIComponent(params.content)}`,
    };
  }

  // Email channel
  const classStudents = await prisma.classStudent.findMany({
    where: { classId: params.classId, isActive: true, student: { status: 0 } },
    select: {
      student: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  const recipients = classStudents.map((entry) => ({
    studentId: entry.student.id,
    name: entry.student.name,
    email: entry.student.email,
  }));

  const savedMessage = await prisma.message.create({
    data: {
      classId: params.classId,
      content: params.content,
      deliveries: {
        createMany: {
          data: recipients.map((recipient) => ({
            studentId: recipient.studentId,
            status: DELIVERY_STATUS.QUEUED,
          })),
        },
      },
    },
    select: { id: true, classId: true, content: true, createdAt: true },
  });

  const emailResults = await Promise.all(
    recipients.map(async (recipient) => {
      if (!recipient.email) {
        return {
          studentId: recipient.studentId,
          status: DELIVERY_STATUS.FAILED,
          error: "No email address on file",
        };
      }

      try {
        await sendClassAnnouncementEmail({
          to: recipient.email,
          studentName: recipient.name,
          className: classroom.name,
          content: params.content,
        });
        return { studentId: recipient.studentId, status: DELIVERY_STATUS.SENT, error: undefined as string | undefined };
      } catch (err) {
        return {
          studentId: recipient.studentId,
          status: DELIVERY_STATUS.FAILED,
          error: err instanceof Error ? err.message : "Send failed",
        };
      }
    })
  );

  await Promise.all(
    emailResults.map((result) =>
      prisma.messageDelivery.updateMany({
        where: { messageId: savedMessage.id, studentId: result.studentId },
        data: { status: result.status, provider: "email", error: result.error },
      })
    )
  );

  const delivered = emailResults.filter((r) => r.status === DELIVERY_STATUS.SENT).length;
  const failed = emailResults.filter((r) => r.status === DELIVERY_STATUS.FAILED).length;

  return {
    message: savedMessage,
    delivery: {
      provider: "email",
      delivered,
      failed,
      queued: 0,
    },
    totalRecipients: recipients.length,
  };
}

export async function listMessagesForClass(params: {
  teacherId: string;
  classId: string;
  dateFrom?: Date;
  dateTo?: Date;
  skip: number;
  take: number;
}) {
  await assertTeacherOwnsClass(params.classId, params.teacherId);

  const createdAtFilter: { gte?: Date; lte?: Date } = {};

  if (params.dateFrom) {
    createdAtFilter.gte = params.dateFrom;
  }

  if (params.dateTo) {
    createdAtFilter.lte = params.dateTo;
  }

  const where = {
    classId: params.classId,
    ...(params.dateFrom || params.dateTo ? { createdAt: createdAtFilter } : {}),
  };

  const [messages, totalItems] = await Promise.all([
    prisma.message.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        classId: true,
        content: true,
        createdAt: true,
        _count: {
          select: {
            deliveries: true,
          },
        },
        deliveries: {
          select: {
            status: true,
          },
        },
      },
    }),
    prisma.message.count({
      where,
    }),
  ]);

  return {
    messages: messages.map((message) => {
      const queued = message.deliveries.filter((item) => item.status === DELIVERY_STATUS.QUEUED).length;
      const sent = message.deliveries.filter((item) => item.status === DELIVERY_STATUS.SENT).length;
      const failed = message.deliveries.filter((item) => item.status === DELIVERY_STATUS.FAILED).length;

      return {
        id: message.id,
        classId: message.classId,
        content: message.content,
        createdAt: message.createdAt,
        deliverySummary: {
          total: message._count.deliveries,
          queued,
          sent,
          failed,
        },
      };
    }),
    totalItems,
  };
}

export async function updateMessageDeliveryStatus(params: {
  providerMessageId: string;
  status: "QUEUED" | "SENT" | "FAILED";
  error?: string;
}) {
  const updated = await prisma.messageDelivery.updateMany({
    where: {
      providerMessageId: params.providerMessageId,
    },
    data: {
      status: params.status,
      error: params.error,
    },
  });

  if (updated.count === 0) {
    throw new AppError("No matching delivery record found.", 404, "DELIVERY_NOT_FOUND");
  }

  return {
    updated: updated.count,
  };
}

export async function listMessageDeliveriesForTeacher(params: {
  teacherId: string;
  messageId: string;
  skip: number;
  take: number;
  status?: "QUEUED" | "SENT" | "FAILED";
}) {
  const message = await prisma.message.findFirst({
    where: {
      id: params.messageId,
      class: {
        teacherId: params.teacherId,
      },
    },
    select: {
      id: true,
      content: true,
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

  if (!message) {
    throw new AppError("Message not found.", 404, "MESSAGE_NOT_FOUND");
  }

  const where = {
    messageId: params.messageId,
    ...(params.status
      ? {
          status: params.status,
        }
      : {}),
  };

  const [deliveries, totalItems] = await Promise.all([
    prisma.messageDelivery.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        messageId: true,
        status: true,
        provider: true,
        providerMessageId: true,
        error: true,
        createdAt: true,
        updatedAt: true,
        student: {
          select: {
            id: true,
            name: true,
            grade: true,
            contact: true,
          },
        },
      },
    }),
    prisma.messageDelivery.count({
      where,
    }),
  ]);

  return {
    message,
    deliveries,
    totalItems,
  };
}
