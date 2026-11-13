import { DeviceApprovalException } from "@/app/exceptions/DeviceApprovalException";
import { AppError } from "@/lib/error-handler";
import { clientKey } from "@/lib/error-logging/request-trust";
import { prisma } from "@/lib/prisma";
import { StudentDeviceStatus } from "@prisma/client";
import {
  buildDeviceApprovalReviewLink,
  buildTeacherLoginLink,
  sendDeviceApprovalRequestEmail,
  sendDeviceDecisionEmail,
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

/**
 * Minimum length of a fingerprint blob used for exact matching (SP-6B). The
 * FingerprintJS components serialised by lib/current-device.ts are far
 * longer; anything shorter is not a fingerprint and never identifies a device.
 */
export const MIN_FINGERPRINT_MATCH_LENGTH = 64;

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

  // Informational only (stored, shown to the teacher): the address appended by
  // the trusted proxy chain (TRUSTED_PROXY_COUNT), never the client-supplied
  // first X-Forwarded-For entry or X-Real-IP; null when it cannot be trusted.
  const ip = clientKey(request);

  // Every device field below is supplied by the browser; none is a secret.
  // Student Profile SP-6B: approval can only be reached through an exact
  // identity match (1 or 2); the coarse attributes (3) never grant it.

  // 1. Exact match on the FingerprintJS visitor id.
  let existingDevice = await prisma.studentDevice.findUnique({
    where: {
      studentId_deviceId: {
        studentId,
        deviceId: device.deviceId,
      },
    },
  });
  let matchedBy: "DEVICE_ID" | "FINGERPRINT" | "ATTRIBUTES" | null = existingDevice ? "DEVICE_ID" : null;

  // 2. Exact match on the stored fingerprint blob (the FingerprintJS
  //    components, kilobytes of JSON). Browser / OS / platform values cannot
  //    produce it; trivially short values are never used to identify a device.
  if (!existingDevice && typeof device.fingerprint === "string" && device.fingerprint.length >= MIN_FINGERPRINT_MATCH_LENGTH) {
    existingDevice = await prisma.studentDevice.findFirst({
      where: {
        studentId,
        fingerprint: device.fingerprint,
      },
    });
    if (existingDevice) matchedBy = "FINGERPRINT";
  }

  // 3. Stable-attribute match: browser name, OS and platform (plus the
  //    hardware model when sent). These are guessable, so they only find an
  //    existing PENDING or BLOCKED request for the same kind of device (no
  //    duplicate requests; a rejected device stays rejected). They NEVER match
  //    an APPROVED device and never change a device's identity: an
  //    unrecognised browser on an approved kind of device is a new device and
  //    waits for the teacher.
  if (!existingDevice) {
    const attributeWhere = {
      studentId,
      browser: device.browser ?? null,
      os: device.os ?? null,
      platform: device.platform ?? null,
      ...(device.deviceModel ? { deviceModel: device.deviceModel } : {}),
    };

    existingDevice = await prisma.studentDevice.findFirst({
      where: { ...attributeWhere, status: { not: StudentDeviceStatus.APPROVED } },
      orderBy: [{ approvalRequestedAt: "desc" }],
    });
    if (existingDevice) matchedBy = "ATTRIBUTES";
  }

  // An exact fingerprint match whose visitor id drifted: refresh the device's
  // identifying data (but never its status). Attribute matches never do this.
  if (existingDevice && matchedBy === "FINGERPRINT" && existingDevice.deviceId !== device.deviceId) {
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
  // SP-6F: removing an APPROVED device ends the student's sessions in the same
  // transaction (see rejectStudentDevice); either both happen or neither.
  return prisma.$transaction(async (tx) => {
    const owned = await tx.studentDevice.findFirst({
      where: { id: deviceId, student: { teacherId } },
      select: { id: true, status: true, studentId: true },
    });

    if (!owned) {
      return { deleted: false };
    }

    // Conditional on the status read: a concurrent change or removal deletes nothing here.
    const removed = await tx.studentDevice.deleteMany({ where: { id: deviceId, status: owned.status } });
    if (removed.count !== 1) {
      return { deleted: false };
    }

    if (owned.status === StudentDeviceStatus.APPROVED) {
      await invalidateStudentSessions(tx, owned.studentId);
    }

    return { deleted: true };
  }, DEVICE_TRANSACTION_OPTIONS);
}

/**
 * Confirms the device belongs to one of this teacher's students. Throws a
 * 404 AppError otherwise so a teacher can never act on another teacher's
 * device by guessing an id.
 */
async function assertDeviceBelongsToTeacher(
  deviceId: string,
  teacherId: string
) {
  const owned = await prisma.studentDevice.findFirst({
    where: { id: deviceId, student: { teacherId } },
    select: { id: true, status: true },
  });

  if (!owned) {
    throw new AppError("Device not found.", 404, "DEVICE_NOT_FOUND");
  }

  return owned;
}

/**
 * Emails the student the teacher's approve / reject decision on one of their
 * devices. Called only after the status update has succeeded and only when the
 * status actually changed. Never throws: an email failure must not undo or fail
 * the decision itself.
 */
async function notifyStudentOfDeviceDecision(
  device: {
    studentId: string;
    deviceName: string | null;
    deviceModel: string | null;
    browser: string | null;
    browserVersion: string | null;
    os: string | null;
    osVersion: string | null;
  },
  decision: "approved" | "rejected",
  reason?: string | null
) {
  try {
    const student = await prisma.student.findUnique({
      where: { id: device.studentId },
      select: { name: true, email: true },
    });

    if (!student?.email) {
      return;
    }

    await sendDeviceDecisionEmail({
      to: student.email,
      decision,
      studentName: student.name,
      deviceName: device.deviceName || device.deviceModel || "Unknown device",
      browser:
        [device.browser, device.browserVersion].filter(Boolean).join(" ") ||
        "Unknown browser",
      os:
        [device.os, device.osVersion].filter(Boolean).join(" ") ||
        "Unknown OS",
      reason,
      loginLink: buildTeacherLoginLink(),
    });
  } catch (error) {
    console.error(`Failed to email student about ${decision} device:`, error);
  }
}

/**
 * All PENDING or BLOCKED devices across a teacher's active students, newest
 * request first — the data behind the Student Device Approvals page.
 */
export async function getDeviceApprovalsForTeacher(
  teacherId: string,
  status: StudentDeviceStatus
) {
  const devices = await prisma.studentDevice.findMany({
    where: {
      status,
      student: { teacherId, status: 0 },
    },
    include: {
      approvedByTeacher: { select: { id: true, name: true } },
      student: {
        select: {
          id: true,
          name: true,
          registrationNumber: true,
          contact: true,
        },
      },
    },
    orderBy: [{ approvalRequestedAt: "desc" }, { createdAt: "desc" }],
  });

  return devices.map((device) => ({
    ...device,
    approvedByTeacher: device.approvedByTeacher
      ? { id: device.approvedByTeacher.id, fullName: device.approvedByTeacher.name }
      : null,
  }));
}

/** Count of devices still awaiting the teacher's decision. */
export function countPendingDeviceApprovalsForTeacher(teacherId: string) {
  return prisma.studentDevice.count({
    where: {
      status: StudentDeviceStatus.PENDING,
      student: { teacherId, status: 0 },
    },
  });
}

/**
 * Records the teacher's written reply to a device request. Stored in
 * `rejectedReason`, which is the field the student portal already surfaces
 * as "your teacher's response".
 */
export async function replyToStudentDevice(
  deviceId: string,
  teacherId: string,
  message: string
) {
  await assertDeviceBelongsToTeacher(deviceId, teacherId);

  return prisma.studentDevice.update({
    where: { id: deviceId },
    data: { rejectedReason: message.trim() },
  });
}

export async function approveStudentDevice(
  deviceId: string,
  teacherId: string,
  reason?: string
) {
  const previous = await assertDeviceBelongsToTeacher(deviceId, teacherId);

  const device = await prisma.studentDevice.update({
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

  if (previous.status !== StudentDeviceStatus.APPROVED) {
    await notifyStudentOfDeviceDecision(device, "approved", reason);
  }

  return device;
}

/*
 * Student Profile SP-6F: blocking or removing a device ends the student's
 * sessions. A JWT is not bound to a device, so the only way to end a session
 * that may be running on that device is the student's session version
 * (lib/student-session.ts): it is incremented in the SAME transaction as the
 * device change, for that student only, and the change is rolled back if the
 * increment does not happen. The student signs in again on their other
 * approved devices.
 *
 * Only a device that was APPROVED can carry a session (a login succeeds only
 * on an approved device), so only blocking or removing an APPROVED device
 * increments the version. Rejecting a PENDING request, re-rejecting a BLOCKED
 * device or removing a PENDING / BLOCKED one signs nobody out.
 */
const DEVICE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

function deviceDecisionConflict() {
  return new AppError("This device was changed at the same time. Please refresh and try again.", 409, "DEVICE_DECISION_CONFLICT");
}

type DeviceTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Ends every session of the student (inside the device transaction); exactly one row or the transaction rolls back. */
async function invalidateStudentSessions(tx: DeviceTransaction, studentId: string) {
  const bumped = await tx.student.updateMany({
    where: { id: studentId },
    data: { sessionVersion: { increment: 1 } },
  });
  if (bumped.count !== 1) {
    throw new AppError("The student's sessions could not be ended. Nothing was changed.", 409, "DEVICE_DECISION_CONFLICT");
  }
}

export async function rejectStudentDevice(
  deviceId: string,
  teacherId: string,
  reason?: string
) {
  const { device, previousStatus } = await prisma.$transaction(async (tx) => {
    // Two tries: a concurrent decision makes the conditional update match nothing;
    // the second read sees its committed result.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const owned = await tx.studentDevice.findFirst({
        where: { id: deviceId, student: { teacherId } },
        select: { id: true, status: true, studentId: true },
      });
      if (!owned) throw new AppError("Device not found.", 404, "DEVICE_NOT_FOUND");

      const changed = await tx.studentDevice.updateMany({
        where: { id: deviceId, status: owned.status },
        data: {
          status: "BLOCKED",
          rejectedAt: new Date(),
          rejectedReason: reason,
          approvedByTeacherId: teacherId,
          approvedAt: null,
          approvedReason: null,
        },
      });
      if (changed.count !== 1) continue;

      if (owned.status === StudentDeviceStatus.APPROVED) {
        await invalidateStudentSessions(tx, owned.studentId);
      }

      const updated = await tx.studentDevice.findUnique({ where: { id: deviceId } });
      if (!updated) throw deviceDecisionConflict();
      return { device: updated, previousStatus: owned.status };
    }
    throw deviceDecisionConflict();
  }, DEVICE_TRANSACTION_OPTIONS);

  // After the commit only (unchanged): a decision email when the status changed.
  if (previousStatus !== StudentDeviceStatus.BLOCKED) {
    await notifyStudentOfDeviceDecision(device, "rejected", reason);
  }

  return device;
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