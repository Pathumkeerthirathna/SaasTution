export interface DeviceDecisionEmailProps {
  decision: "approved" | "rejected";
  studentName: string;
  deviceName: string;
  browser: string;
  os: string;
  /** The teacher's note, when one was given. */
  reason?: string | null;
  /** Student login page; shown on approval. */
  loginLink: string;
}

function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getDeviceDecisionEmail(props: DeviceDecisionEmailProps) {
  const approved = props.decision === "approved";
  const studentName = escape(props.studentName);
  const deviceName = escape(props.deviceName);
  const browser = escape(props.browser);
  const os = escape(props.os);
  const loginLink = escape(props.loginLink);
  const reason = props.reason?.trim() ? escape(props.reason.trim()) : "";

  const headerGradient = approved
    ? "linear-gradient(135deg,#10b981,#059669,#047857)"
    : "linear-gradient(135deg,#d97706,#ea580c,#dc2626)";
  const icon = approved ? "✅" : "🚫";
  const title = approved ? "Device Approved" : "Device Not Approved";
  const subtitle = approved
    ? "You can now sign in to SLClassroom from this device."
    : "Your teacher did not approve sign-in from this device.";

  const message = approved
    ? `Good news! Your teacher has approved the device below. You can now sign in to <strong>SLClassroom</strong> from it.`
    : `Your teacher has rejected sign-in to <strong>SLClassroom</strong> from the device below. If you think this is a mistake, please contact your teacher or request approval again from the login screen.`;

  const reasonRow = reason
    ? `
        <tr${approved ? "" : ' style="background:#f8fafc;"'}>
        <td><strong>💬 ${approved ? "Teacher's note" : "Reason"}</strong></td>
        <td>${reason}</td>
        </tr>
      `
    : "";

  const loginButton = approved
    ? `
        <tr>
        <td style="padding:0 40px 40px;text-align:center;">
        <a href="${loginLink}" style="display:inline-block;background:#112D5C;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 32px;border-radius:10px;">
        Sign in to SLClassroom
        </a>
        <p style="margin:16px 0 0;color:#64748b;font-size:13px;line-height:22px;">
        Or open this link: <a href="${loginLink}" style="color:#2563eb;">${loginLink}</a>
        </p>
        </td>
        </tr>
      `
    : "";

  return `
    <!DOCTYPE html>

        <html lang="en">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title}</title>
        </head>

        <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
        <tr>
        <td align="center">

        <table role="presentation" cellpadding="0" cellspacing="0" width="650" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

        <!-- Header -->

        <tr>
        <td style="background:${headerGradient};padding:42px;text-align:center;">

        <div style="font-size:52px;line-height:1;">${icon}</div>

        <div style="font-size:30px;font-weight:700;color:#ffffff;margin-top:12px;">
        ${title}
        </div>

        <div style="color:rgba(255,255,255,.92);font-size:16px;margin-top:10px;">
        ${subtitle}
        </div>

        </td>
        </tr>

        <!-- Greeting -->

        <tr>
        <td style="padding:40px 40px 24px;">

        <p style="margin:0;color:#0f172a;font-size:17px;">
        Hi <strong>${studentName}</strong>,
        </p>

        <p style="margin:20px 0 0;color:#475569;font-size:15px;line-height:28px;">
        ${message}
        </p>

        </td>
        </tr>

        <!-- Details Card -->

        <tr>
        <td style="padding:0 40px 30px;">

        <table width="100%" cellpadding="12" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;color:#334155;font-size:14px;">

        <tr style="background:#f8fafc;">
        <td width="40%"><strong>💻 Device</strong></td>
        <td>${deviceName}</td>
        </tr>

        <tr>
        <td><strong>🌐 Browser</strong></td>
        <td>${browser}</td>
        </tr>

        <tr style="background:#f8fafc;">
        <td><strong>🖥️ Operating System</strong></td>
        <td>${os}</td>
        </tr>
        ${reasonRow}
        </table>

        </td>
        </tr>
        ${loginButton}
        <!-- Footer -->

        <tr>
        <td style="background:#0f172a;padding:35px;text-align:center;">

        <div style="font-size:20px;color:#ffffff;font-weight:bold;">
        SLClassroom
        </div>

        <div style="margin-top:10px;color:#cbd5e1;font-size:15px;">
        Empowering Learning Through Technology
        </div>

        <p style="margin-top:24px;color:#94a3b8;font-size:13px;line-height:24px;">
        This is an automated message from SLClassroom.<br/>
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

  `;
}
