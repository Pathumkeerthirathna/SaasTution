export interface DeviceApprovalRequestEmailProps {
  teacherName: string;
  studentName: string;
  className: string;
  deviceName: string;
  browser: string;
  os: string;
  ipAddress: string;
  requestedAt: string;
  reviewLink: string;
}

export function getDeviceApprovalRequestEmail(
  props: DeviceApprovalRequestEmailProps
) {
  return `
    <!DOCTYPE html>

        <html lang="en">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>New Device Approval Needed</title>
        </head>

        <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
        <tr>
        <td align="center">

        <table role="presentation" cellpadding="0" cellspacing="0" width="650" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

        <!-- Header -->

        <tr>
        <td style="background:linear-gradient(135deg,#d97706,#ea580c,#dc2626);padding:42px;text-align:center;">

        <div style="font-size:52px;line-height:1;">🔒</div>

        <div style="font-size:30px;font-weight:700;color:#ffffff;margin-top:12px;">
        New Device Approval Needed
        </div>

        <div style="color:rgba(255,255,255,.92);font-size:16px;margin-top:10px;">
        A student signed in from a device we haven't seen before.
        </div>

        </td>
        </tr>

        <!-- Greeting -->

        <tr>
        <td style="padding:40px;">

        <p style="margin:0;font-size:17px;color:#1f2937;">
        Hello <strong>{{TeacherName}}</strong>,
        </p>

        <p style="margin:20px 0 0;color:#475569;font-size:15px;line-height:28px;">
        <strong>{{StudentName}}</strong> just tried to sign in to <strong>SLClassroom</strong> from a device that isn't approved yet.
        For account security, sign-in from this device is on hold until you review and confirm it.
        </p>

        </td>
        </tr>

        <!-- Details Card -->

        <tr>
        <td style="padding:0 40px 30px;">

        <table width="100%" cellpadding="12" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;">

        <tr style="background:#f8fafc;">
        <td><strong>👤 Student</strong></td>
        <td>{{StudentName}}</td>
        </tr>

        <tr>
        <td><strong>📚 Class</strong></td>
        <td>{{ClassName}}</td>
        </tr>

        <tr style="background:#f8fafc;">
        <td><strong>📱 Device</strong></td>
        <td>{{DeviceName}}</td>
        </tr>

        <tr>
        <td><strong>🌐 Browser</strong></td>
        <td>{{Browser}}</td>
        </tr>

        <tr style="background:#f8fafc;">
        <td><strong>💻 Operating System</strong></td>
        <td>{{Os}}</td>
        </tr>

        <tr>
        <td><strong>📍 IP Address</strong></td>
        <td>{{IpAddress}}</td>
        </tr>

        <tr style="background:#f8fafc;">
        <td><strong>🕒 Requested At</strong></td>
        <td>{{RequestedAt}}</td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- Action -->

        <tr>
        <td style="padding:0 40px 35px;">

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border:1px solid #fdba74;border-radius:14px;">

        <tr>
        <td style="padding:28px;">

        <div style="font-size:22px;font-weight:bold;color:#9a3412;">
        ✅ Review and Confirm
        </div>

        <p style="margin-top:18px;color:#444;line-height:28px;font-size:15px;">
        Open the student's profile to check these details and either approve this device so
        <strong>{{StudentName}}</strong> can sign in, or reject it if you don't recognize it.
        </p>

        </td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- CTA -->

        <tr>
        <td align="center" style="padding:0 40px 40px;">

        <a href="{{ReviewLink}}"
        style="
        display:inline-block;
        padding:16px 40px;
        background:#ea580c;
        color:#ffffff;
        font-size:16px;
        font-weight:bold;
        text-decoration:none;
        border-radius:10px;">
        Review Device Request </a>

        </td>
        </tr>

        <!-- Security -->

        <tr>
        <td style="padding:0 40px 35px;">

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e5e7eb;">

        <tr>
        <td style="padding:24px;">

        <div style="font-size:18px;font-weight:bold;color:#111827;">
        🛡️ Only Approve Devices You Recognize
        </div>

        <p style="margin-top:12px;color:#4b5563;line-height:28px;font-size:15px;">
        If this device or location looks unfamiliar, reject the request. The student will be asked to try
        again from a device you've already approved, or you can ask them to confirm before allowing access.
        </p>

        </td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- Footer -->

        <tr>
        <td style="background:#0f172a;padding:35px;text-align:center;">

        <div style="font-size:20px;color:#ffffff;font-weight:bold;">
        SLClassroom
        </div>

        <div style="margin-top:10px;color:#cbd5e1;font-size:15px;">
        Empowering Learning Through Technology
        </div>

        <div style="margin-top:20px;">
        <a href="https://slclassroom.live" style="color:#34d399;text-decoration:none;font-weight:bold;">
        https://slclassroom.live
        </a>
        </div>

        <p style="margin-top:24px;color:#94a3b8;font-size:13px;line-height:24px;">
        This is an automated security notice from SLClassroom.<br/>
        Please do not reply to this email.
        </p>

        </td>
        </tr>

        </table>

        </td>
        </tr>
        </table>

        </body>
        </html>

  `
    .replace(/{{TeacherName}}/g, props.teacherName)
    .replace(/{{StudentName}}/g, props.studentName)
    .replace(/{{ClassName}}/g, props.className)
    .replace(/{{DeviceName}}/g, props.deviceName)
    .replace(/{{Browser}}/g, props.browser)
    .replace(/{{Os}}/g, props.os)
    .replace(/{{IpAddress}}/g, props.ipAddress)
    .replace(/{{RequestedAt}}/g, props.requestedAt)
    .replace(/{{ReviewLink}}/g, props.reviewLink);
}
