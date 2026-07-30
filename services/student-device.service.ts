import { DeviceApprovalException } from "@/app/exceptions/DeviceApprovalException";
import { prisma } from "@/lib/prisma";
import { StudentDeviceStatus } from "@prisma/client";

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

  let existingDevice = await prisma.studentDevice.findUnique({
    where: {
      studentId_deviceId: {
        studentId,
        deviceId: device.deviceId,
      },
    },
  });

  if (!existingDevice && device.fingerprint) {
    existingDevice = await prisma.studentDevice.findFirst({
      where: {
        studentId,
        fingerprint: device.fingerprint,
      },
    });
  }

  if (!existingDevice && device.deviceModel) {
    existingDevice = await prisma.studentDevice.findFirst({
      where: {
        studentId,
        browser: device.browser,
        os: device.os,
        deviceModel: device.deviceModel,
        platform: device.platform,
      },
    });
  }


 if (
  existingDevice &&
  existingDevice.deviceId !== device.deviceId
  ) {
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
  return prisma.studentDevice.findMany({
    where: {
      studentId,
    },
    include: {
      approvedByTeacher: {
        select: {
          id: true,
          name: true, // change to your Teacher name property
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
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

    return prisma.studentDevice.update({

        where: {
            id: deviceId,
        },

        data: {

            // status: StudentDeviceStatus.PENDING,

            approvalRequestMessage: message,

            // rejectedAt: null,

            // approvedAt: null,

            // approvedReason: null,

            // approvedByTeacherId: null,

            approvalRequestedAt: new Date(),

        },

    });

}