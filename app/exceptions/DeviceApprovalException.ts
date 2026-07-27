// src/exceptions/device-approval.exception.ts

// export class DeviceApprovalException extends Error {
//   constructor(
//     public readonly code:
//       | "DEVICE_REQUIRED"
//       | "DEVICE_PENDING"
//       | "DEVICE_REJECTED",
//     message: string,
//     public readonly statusCode = 403
//   ) {
//     super(message);
//     this.name = "DeviceApprovalException";
//   }
// }

export class DeviceApprovalException extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly statusCode = 403,
        public readonly data?: unknown
    ) {
        super(message);
    }
}