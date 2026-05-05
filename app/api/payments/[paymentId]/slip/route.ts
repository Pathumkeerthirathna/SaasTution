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
  context: { params: { paymentId: string } }
) {
  try {
    const session = await requireAppSession();
    const paymentId = context.params.paymentId;

    if (!paymentId?.trim()) {
      throw new AppError("Payment id is required.", 400, "VALIDATION_ERROR");
    }

    const payment = await prisma.classPayment.findUnique({
      where: { id: paymentId },
      select: {
        slipFileName: true,
        slipFileUrl: true,
        slipMimeType: true,
        class: {
          select: {
            teacherId: true,
          },
        },
        studentId: true,
      },
    });

    if (!payment || !payment.slipFileUrl || !payment.slipFileName) {
      throw new AppError("Payment slip not found.", 404, "FILE_NOT_FOUND");
    }

    const isTeacher = session.role === "TEACHER" && payment.class.teacherId === session.userId;
    const isStudent = session.role === "STUDENT" && payment.studentId === session.userId;

    if (!isTeacher && !isStudent) {
      throw new AppError("You do not have access to this payment slip.", 403, "FORBIDDEN");
    }

    const root = path.join(process.cwd(), "storage");
    const filePath = path.join(root, payment.slipFileUrl);
    assertPathInBounds(filePath, root);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("Payment slip is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const encodedName = encodeURIComponent(payment.slipFileName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": payment.slipMimeType || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename="${payment.slipFileName}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
