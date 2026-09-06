export interface TeacherAccountConfirmedEmailProps {
  teacherName: string;
  planName: string | null;
  planPrice: string | null;
  planInterval: string | null;
  loginLink: string;
}

export function getTeacherAccountConfirmedEmail(
  props: TeacherAccountConfirmedEmailProps
) {
  const hasPlan = Boolean(props.planName);

  const planRows = hasPlan
    ? `
        <tr style="background:#f8fafc;">
        <td><strong>📦 Plan</strong></td>
        <td>{{PlanName}}</td>
        </tr>

        <tr>
        <td><strong>💳 Price</strong></td>
        <td>{{PlanPrice}} / {{PlanInterval}}</td>
        </tr>
      `
    : "";

  return `
    <!DOCTYPE html>

        <html lang="en">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Your SLClassroom Account Is Confirmed</title>
        </head>

        <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
        <tr>
        <td align="center">

        <table role="presentation" cellpadding="0" cellspacing="0" width="650" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

        <!-- Header -->

        <tr>
        <td style="background:linear-gradient(135deg,#0ea5e9,#2563eb,#4338ca);padding:42px;text-align:center;">

        <div style="font-size:52px;line-height:1;">🎉</div>

        <div style="font-size:30px;font-weight:700;color:#ffffff;margin-top:12px;">
        Congratulations, {{TeacherName}}!
        </div>

        <div style="color:rgba(255,255,255,.92);font-size:16px;margin-top:10px;">
        Your SLClassroom account has been confirmed.
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
        Great news — our team has reviewed and confirmed your <strong>SLClassroom</strong> account.
        You can now sign in and start holding lectures, adding students, sharing tutes and papers,
        tracking payments, and everything else the platform offers.
        </p>

        </td>
        </tr>

        ${
          hasPlan
            ? `
        <!-- Plan Card -->

        <tr>
        <td style="padding:0 40px 30px;">

        <table width="100%" cellpadding="12" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;">

        ${planRows}

        </table>

        </td>
        </tr>
        `
            : ""
        }

        <!-- Action -->

        <tr>
        <td style="padding:0 40px 35px;">

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #93c5fd;border-radius:14px;">

        <tr>
        <td style="padding:28px;">

        <div style="font-size:22px;font-weight:bold;color:#1e3a8a;">
        🚀 You're all set
        </div>

        <p style="margin-top:18px;color:#444;line-height:28px;font-size:15px;">
        Sign in to your dashboard to create your first class, invite students, and schedule your
        first live lecture.
        </p>

        </td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- CTA -->

        <tr>
        <td align="center" style="padding:0 40px 40px;">

        <a href="{{LoginLink}}"
        style="
        display:inline-block;
        padding:16px 40px;
        background:#2563eb;
        color:#ffffff;
        font-size:16px;
        font-weight:bold;
        text-decoration:none;
        border-radius:10px;">
        Log In to SLClassroom </a>

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

  `
    .replace(/{{TeacherName}}/g, props.teacherName)
    .replace(/{{PlanName}}/g, props.planName ?? "")
    .replace(/{{PlanPrice}}/g, props.planPrice ?? "")
    .replace(/{{PlanInterval}}/g, props.planInterval ?? "")
    .replace(/{{LoginLink}}/g, props.loginLink);
}
