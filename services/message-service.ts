import { AppError } from "@/lib/error-handler";
import { sendClassAnnouncementEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { emitStudentDataChange } from "@/lib/session-events";

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

type MessageChannel = "email" | "whatsapp";

export async function sendClassMessage(params: {
  teacherId: string;
  classId: string;
  content: string;
  channels: MessageChannel[];
}) {
  // No channel selected = post in the app only. The Message + per-student
  // MessageDelivery rows are always written and pushed over SSE regardless.
  const wantsEmail = params.channels.includes("email");
  const wantsWhatsApp = params.channels.includes("whatsapp");
  const inAppOnly = !wantsEmail && !wantsWhatsApp;

  const classroom = await assertTeacherOwnsClass(params.classId, params.teacherId);

  const classStudents = await prisma.classStudent.findMany({
    where: { classId: params.classId, isActive: true, student: { status: 0 } },
    select: {
      student: { select: { id: true, name: true, email: true, contact: true } },
    },
  });

  // A student can hold more than one enrolment row for the same class — dedupe by
  // id so the MessageDelivery `@@unique([messageId, studentId])` never collides.
  const recipientMap = new Map<
    string,
    { id: string; name: string; email: string | null; contact: string }
  >();
  for (const entry of classStudents) {
    if (!recipientMap.has(entry.student.id)) {
      recipientMap.set(entry.student.id, entry.student);
    }
  }
  const recipients = [...recipientMap.values()];

  if (recipients.length === 0) {
    throw new AppError(
      "This class has no active students to message.",
      409,
      "NO_RECIPIENTS"
    );
  }

  const primaryProvider = wantsEmail ? "email" : wantsWhatsApp ? "whatsapp" : "app";

  const savedMessage = await prisma.message.create({
    data: {
      classId: params.classId,
      content: params.content,
      deliveries: {
        createMany: {
          data: recipients.map((recipient) => ({
            studentId: recipient.id,
            // In-app delivery lands the moment it's saved; external channels stay queued.
            status: inAppOnly ? DELIVERY_STATUS.SENT : DELIVERY_STATUS.QUEUED,
            provider: primaryProvider,
          })),
          skipDuplicates: true,
        },
      },
    },
    select: { id: true, classId: true, content: true, createdAt: true },
  });

  let email: { sent: number; failed: number } | null = null;

  if (wantsEmail) {
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        if (!recipient.email) {
          return {
            studentId: recipient.id,
            status: DELIVERY_STATUS.FAILED,
            error: "No email address on file" as string | undefined,
          };
        }

        try {
          await sendClassAnnouncementEmail({
            to: recipient.email,
            studentName: recipient.name,
            className: classroom.name,
            content: params.content,
          });
          return {
            studentId: recipient.id,
            status: DELIVERY_STATUS.SENT,
            error: undefined as string | undefined,
          };
        } catch (err) {
          console.error("[message-service] announcement email failed", {
            classId: params.classId,
            studentId: recipient.id,
            error: err instanceof Error ? err.message : err,
          });
          return {
            studentId: recipient.id,
            status: DELIVERY_STATUS.FAILED,
            error: err instanceof Error ? err.message : "Send failed",
          };
        }
      })
    );

    await Promise.all(
      results.map((result) =>
        prisma.messageDelivery.updateMany({
          where: { messageId: savedMessage.id, studentId: result.studentId },
          data: { status: result.status, provider: "email", error: result.error },
        })
      )
    );

    email = {
      sent: results.filter((r) => r.status === DELIVERY_STATUS.SENT).length,
      failed: results.filter((r) => r.status === DELIVERY_STATUS.FAILED).length,
    };
  }

  // Tell every connected student of this class to re-pull (header bell + dashboard).
  emitStudentDataChange({ classId: params.classId });

  return {
    message: savedMessage,
    recipientCount: recipients.length,
    email,
    whatsapp: wantsWhatsApp
      ? {
          url: `https://wa.me/?text=${encodeURIComponent(params.content)}`,
          recipientCount: recipients.filter((r) => r.contact.trim().length > 0).length,
        }
      : null,
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
