import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError, apiSuccess } from "@/lib/api-response";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  try {
    const { deviceId } = await params;

    const body = await request.json();

    if (!body.rejectedReason?.trim()) {
      return apiError(
        "Teacher response is required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const device = await prisma.studentDevice.findUnique({
      where: {
        id: deviceId,
      },
    });

    if (!device) {
      return apiError(
        "Device not found.",
        404,
        "DEVICE_NOT_FOUND"
      );
    }

    const updatedDevice = await prisma.studentDevice.update({
      where: {
        id: deviceId,
      },
      data: {
        rejectedReason: body.rejectedReason.trim(),
      },
    });

    return apiSuccess(
      updatedDevice
    );
  } catch (error) {
    console.error(error);

    return apiError(
      "Unable to update teacher response.",
      500,
      "INTERNAL_SERVER_ERROR"
    );
  }
}