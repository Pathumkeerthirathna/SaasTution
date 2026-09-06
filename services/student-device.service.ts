import { DeviceApprovalException } from "@/app/exceptions/DeviceApprovalException";
import { prisma } from "@/lib/prisma";
import { StudentDeviceStatus } from "@prisma/client";
import {
  buildDeviceApprovalReviewLink,
  sendDeviceApprovalRequestEmail,
} from "@/lib/mailer";

async function notifyTeacherOfPendingDevice(
  studentId: string,
  device: {
    deviceName: string | null;
    deviceModel: string | null;
    browser: string | null;
    browserVersion: string | null;
    os: string | null;
    osVersion: string | null;
    lastIpAddress: string | null;
    approvalRequestedAt: Date;
  }
) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      name: true,
      teacher: {
        select: { name: true, email: true },
      },
      classes: {
        where: { isActive: true },
        select: { class: { select: { name: true } } },
      },
    },
  });

  if (!student?.teacher?.email) {
    return;
  }

  const className =
    student.classes.map((c) => c.class.name).join(", ") ||
    "No class assigned";

  const deviceName =
    device.deviceName ||
    device.deviceModel ||
    "Unknown device";

  const browser = [device.browser, device.browserVersion]
    .filter(Boolean)
    .join(" ") || "Unknown browser";

  const os = [device.os, device.osVersion]
    .filter(Boolean)
    .join(" ") || "Unknown OS";

  await sendDeviceApprovalRequestEmail({
    to: student.teacher.email,
    teacherName: student.teacher.name,
    studentName: student.name,
    className,
    deviceName,
    browser,
    os,
    ipAddress: device.lastIpAddress || "Unknown",
    requestedAt: device.approvalRequestedAt.toLocaleString(),
    reviewLink: buildDeviceApprovalReviewLink(studentId),
  });
}

type ValidateStudentDeviceParams = {
  studentId: string;
  device?: {
    deviceId: string;
    fingerprint?: string;

    browser?: string;
    browserVersion?: string;

    os?: string;
    osVersion?: string;

    deviceModel?: string;
    deviceName?: string;

    platform?: string;
    userAgent?: string;

    language?: string;
    timezone?: string;
  };
  request: Request;
};

export async function validateStudentDevice({
  studentId,
  device,
  request,
}: ValidateStudentDeviceParams) {

  if (!device?.deviceId) {
    throw new DeviceApprovalException(
      "DEVICE_REQUIRED",
      "Device information is required.",
      400
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    null;

  // 1. Exact match on the FingerprintJS visitor id.
  let existingDevice = await prisma.studentDevice.findUnique({
    where: {
      studentId_deviceId: {
        studentId,
        deviceId: device.deviceId,
      },
    },
  });

  // 2. Exact match on the stored fingerprint blob.
  if (!existingDevice && device.fingerprint) {
    existingDevice = await prisma.studentDevice.findFirst({
      where: {
        studentId,
        fingerprint: device.fingerprint,
      },
    });
  }

  // 3. Stable-attribute match. The FingerprintJS visitor id and the fingerprint
  //    blob both drift over time (browser updates, setting changes), so fall
  //    back to the attributes we actually surface as "a device": the browser
  //    name, OS and platform (plus the hardware model on mobile). Browser and
  //    OS *versions* are deliberately excluded so a Chrome 150 -> 151 update
  //    does not register as a brand-new device. An already-approved match wins.
  if (!existingDevice) {
    const attributeWhere = {
      studentId,
      browser: device.browser ?? null,
      os: device.os ?? null,
      platform: device.platform ?? null,
      ...(device.deviceModel ? { deviceModel: device.deviceModel } : {}),
    };

    existingDevice =
      (await prisma.studentDevice.findFirst({
        where: { ...attributeWhere, status: StudentDeviceStatus.APPROVED },
        orderBy: { lastLoginAt: "desc" },
      })) ??
      (await prisma.studentDevice.findFirst({
        where: attributeWhere,
        orderBy: [{ approvalRequestedAt: "desc" }],
      }));
  }

  // When we matched an existing device by fingerprint/attributes rather than by
  // the exact visitor id, refresh its identifying data (but never its status).
  if (existingDevice && existingDevice.deviceId !== device.deviceId) {
    existingDevice = await prisma.studentDevice.update({
      where: {
        id: existingDevice.id,
      },
      data: {
        deviceId: device.deviceId,
        fingerprint: device.fingerprint,

        browser: device.browser,
        browserVersion: device.browserVersion,

        os: device.os,
        osVersion: device.osVersion,

        deviceModel: device.deviceModel,
        deviceName: device.deviceName,

        platform: device.platform,
        userAgent: device.userAgent,

        lastIpAddress: ip,
        lastLoginAt: new Date(),
      },
    });

    // Clean up stale PENDING duplicates for the same physical device that
    // earlier logins created before this match could be made.
    if (existingDevice.status === StudentDeviceStatus.APPROVED) {
      await prisma.studentDevice.deleteMany({
        where: {
          studentId,
          id: { not: existingDevice.id },
          status: StudentDeviceStatus.PENDING,
          browser: device.browser ?? null,
          os: device.os ?? null,
          platform: device.platform ?? null,
        },
      });
    }
  }

  const approvedDevices = await prisma.studentDevice.findMany({
      where: {
          studentId,
          status: StudentDeviceStatus.APPROVED,
      },
      select: {
          id: true,
          deviceName: true,
          browser: true,
          os: true,
          lastLoginAt: true,
          platform:true,
          approvedReason:true,
          rejectedReason:true,
          approvalRequestMessage:true

      },
  });

  // First login from this device
  if (!existingDevice) {

    const createdDevice = await prisma.studentDevice.create({
      data: {
        studentId,

        deviceId: device.deviceId,
        fingerprint: device.fingerprint,

        browser: device.browser,
        browserVersion: device.browserVersion,

        os: device.os,
        osVersion: device.osVersion,

        deviceModel: device.deviceModel,
        deviceName: device.deviceName,

        platform: device.platform,
        userAgent: device.userAgent,

        lastIpAddress: ip,

        status: StudentDeviceStatus.PENDING,
      },
    });

    try {
      await notifyTeacherOfPendingDevice(studentId, createdDevice);
    } catch (error) {
      // The student must still see the "awaiting approval" screen even if
      // the notification email fails to send.
      console.error("Failed to email teacher about pending device:", error);
    }

    throw new DeviceApprovalException(
      "DEVICE_PENDING",
      "This device is awaiting your teacher's approval.",
        403,
        {
        currentDevice: {
          id: createdDevice.id,
          deviceName: createdDevice.deviceName,
          deviceModel: createdDevice.deviceModel,
          browser: createdDevice.browser,
          browserVersion: createdDevice.browserVersion,
          os: createdDevice.os,
          osVersion: createdDevice.osVersion,
          platform: createdDevice.platform,
          status: createdDevice.status,
        },
        approvedDevices,
        allowRequestAgain: false,
      }
    );
  }



  if (existingDevice.status === StudentDeviceStatus.PENDING) {
    throw new DeviceApprovalException(
      "DEVICE_PENDING",
      "Your device is awaiting teacher approval.",
       403,
        {
          currentDevice: {
            id: existingDevice.id,
            deviceName: existingDevice.deviceName,
            deviceModel: existingDevice.deviceModel,
            browser: existingDevice.browser,
            browserVersion: existingDevice.browserVersion,
            os: existingDevice.os,
            osVersion: existingDevice.osVersion,
            platform: existingDevice.platform,
            status: existingDevice.status,
            rejectedReason: existingDevice.rejectedReason,
            rejectedAt: existingDevice.rejectedAt,
            approvalRequestMessage: existingDevice.approvalRequestMessage,
          },
          approvedDevices,
          allowRequestAgain: true,
        }
    );
  }

  if (existingDevice.status === StudentDeviceStatus.BLOCKED) {
    throw new DeviceApprovalException(
      "DEVICE_REJECTED",
      "This device has been rejected. Please contact your teacher.",
      403,
        {
          currentDevice: {
            id: existingDevice.id,
            deviceName: existingDevice.deviceName,
            deviceModel: existingDevice.deviceModel,
            browser: existingDevice.browser,
            browserVersion: existingDevice.browserVersion,
            os: existingDevice.os,
            osVersion: existingDevice.osVersion,
            platform: existingDevice.platform,
            status: existingDevice.status,
            rejectedReason: existingDevice.rejectedReason,
            rejectedAt: existingDevice.rejectedAt,
            approvalRequestMessage: existingDevice.approvalRequestMessage,
          },
          approvedDevices,
          allowRequestAgain: true,
        }
    );
  }

  await prisma.studentDevice.update({
    where: {
      id: existingDevice.id,
    },
    data: {
      lastLoginAt: new Date(),
      lastIpAddress: ip,
    },
  });
}

export async function getStudentDevicesByStudentId(studentId: string) {
  const devices = await prisma.studentDevice.findMany({
    where: {
      studentId,
    },
    include: {
      approvedByTeacher: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  // The UI expects `approvedByTeacher.fullName`.
  return devices.map((device) => ({
    ...device,
    approvedByTeacher: device.approvedByTeacher
      ? {
          id: device.approvedByTeacher.id,
          fullName: device.approvedByTeacher.name,
        }
      : null,
  }));
}


/**
 * Permanently removes a student device record. Any login-history rows that
 * referenced it keep their audit data but lose the device link (SET NULL).
 */
export async function deleteStudentDeviceForTeacher(
  deviceId: string,
  teacherId: string
) {
  const owned = await prisma.studentDevice.findFirst({
    where: { id: deviceId, student: { teacherId } },
    select: { id: true },
  });

  if (!owned) {
    return { deleted: false };
  }

  await prisma.studentDevice.delete({ where: { id: deviceId } });
  return { deleted: true };
}

export async function approveStudentDevice(
  deviceId: string,
  teacherId: string,
  reason?: string
) {
  return prisma.studentDevice.update({
    where: {
      id: deviceId,
    },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedReason: reason,
      approvedByTeacherId: teacherId,
      rejectedAt: null,
      rejectedReason: null,
    },
  });
}

export async function rejectStudentDevice(
  deviceId: string,
  teacherId: string,
  reason?: string
) {
  return prisma.studentDevice.update({
    where: {
      id: deviceId,
    },
    data: {
      status: "BLOCKED",
      rejectedAt: new Date(),
      rejectedReason: reason,
      approvedByTeacherId: teacherId,
      approvedAt: null,
      approvedReason: null,
    },
  });
}

export async function requestApprovalAgain(
    deviceId: string,
    message: string
) {
    const now = new Date();

    // Re-submitting a request only records the student's new message and the
    // time it was sent. The device status is left untouched — a rejected
    // (BLOCKED) device stays rejected until the teacher acts on it.
    return prisma.studentDevice.update({
        where: {
            id: deviceId,
        },
        data: {
            approvalRequestMessage: message,
            approvalRequestedAt: now,
            approvalRequestedByStudentAt: now,
        },
    });
}