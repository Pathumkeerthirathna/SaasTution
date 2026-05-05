import { readFile } from "node:fs/promises";
import path from "node:path";

import { requireAppSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

export async function GET(
  _request: Request,
  context: { params: { messageId: string } }
) {
  try {
    const session = await requireAppSession();
    const messageId = context.params.messageId;

    if (!messageId?.trim()) {
      throw new AppError("Message id is required.", 400, "VALIDATION_ERROR");
    }

    const message = await prisma.paymentMessage.findUnique({
      where: { id: messageId },
      select: {
        proofFileName: true,
        proofFileUrl: true,
        proofMimeType: true,
        payment: {
          select: {
            studentId: true,
            class: {
              select: {
                teacherId: true,
              },
            },
          },
        },
      },
    });

    if (!message || !message.proofFileUrl || !message.proofFileName) {
      throw new AppError("Proof file not found.", 404, "FILE_NOT_FOUND");
    }

    const isTeacher = session.role === "TEACHER" && message.payment.class.teacherId === session.userId;
    const isStudent = session.role === "STUDENT" && message.payment.studentId === session.userId;

    if (!isTeacher && !isStudent) {
      throw new AppError("You do not have access to this proof file.", 403, "FORBIDDEN");
    }

    const root = path.join(process.cwd(), "storage");
    const filePath = path.join(root, message.proofFileUrl);
    assertPathInBounds(filePath, root);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("Proof file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const encodedName = encodeURIComponent(message.proofFileName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": message.proofMimeType || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename="${message.proofFileName}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
