/*
 * The ONE welcome email every newly created student receives (public class
 * registration, teacher's Add Student, bulk import): the registration number,
 * the temporary password, the login link and first-login instructions.
 * Every value is HTML-escaped. The text version carries the same content.
 */

export interface StudentWelcomeCredentialsEmailProps {
  registrationNumber: string;
  temporaryPassword: string;
  loginUrl: string;
}

export const STUDENT_WELCOME_SUBJECT = "Welcome to SLClassroom – Your Login Credentials";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getStudentWelcomeCredentialsText(props: StudentWelcomeCredentialsEmailProps): string {
  return [
    "Hello!",
    "",
    "Your SLClassroom account has been created successfully.",
    "",
    "You can now log in using the following credentials:",
    "",
    `Registration Number: ${props.registrationNumber}`,
    "",
    `Temporary Password: ${props.temporaryPassword}`,
    "",
    `Login: ${props.loginUrl}`,
    "",
    "You can change your password during your first login or later through your account settings.",
    "",
    "Please remember that your teacher must approve your device before you can access your classroom.",
    "",
    "Welcome to SLClassroom!",
    "",
    "SLClassroom Team",
  ].join("\n");
}

export function getStudentWelcomeCredentialsEmail(props: StudentWelcomeCredentialsEmailProps): string {
  const registrationNumber = escapeHtml(props.registrationNumber);
  const temporaryPassword = escapeHtml(props.temporaryPassword);
  const loginUrl = escapeHtml(props.loginUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Welcome to SLClassroom</title>
</head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">

<tr><td style="background:#112D5C;padding:32px;text-align:center;">
<div style="font-size:26px;font-weight:700;color:#ffffff;">Welcome to SLClassroom</div>
<div style="color:rgba(255,255,255,.9);font-size:15px;margin-top:8px;">Your account has been created successfully.</div>
</td></tr>

<tr><td style="padding:32px 32px 8px;">
<p style="margin:0;font-size:16px;color:#1f2937;">Hello!</p>
<p style="margin:16px 0 0;color:#475569;font-size:15px;line-height:26px;">
Your SLClassroom account has been created successfully. You can now log in using the following credentials:
</p>
</td></tr>

<tr><td style="padding:16px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #4D6C90;border-radius:12px;background:#f8fafc;">
<tr><td style="padding:20px 24px;">
<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#475569;font-weight:bold;">Registration Number</div>
<div style="margin-top:6px;font-size:24px;font-weight:bold;color:#112D5C;letter-spacing:1px;">${registrationNumber}</div>
<div style="margin-top:18px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#475569;font-weight:bold;">Temporary Password</div>
<div style="margin-top:6px;font-size:22px;font-weight:bold;color:#112D5C;letter-spacing:1px;font-family:'Courier New',Courier,monospace;">${temporaryPassword}</div>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:16px 32px 8px;">
<a href="${loginUrl}" style="display:inline-block;padding:14px 36px;background:#112D5C;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;border-radius:10px;">Log in to SLClassroom</a>
<div style="margin-top:10px;font-size:13px;color:#64748b;">${loginUrl}</div>
</td></tr>

<tr><td style="padding:16px 32px 8px;">
<p style="margin:0;color:#475569;font-size:15px;line-height:26px;">
You can change your password during your first login or later through your account settings.
</p>
<p style="margin:14px 0 0;color:#475569;font-size:15px;line-height:26px;">
Please remember that your teacher must approve your device before you can access your classroom.
</p>
</td></tr>

<tr><td style="padding:16px 32px 32px;">
<p style="margin:0;color:#1f2937;font-size:15px;line-height:26px;">Welcome to SLClassroom!</p>
<p style="margin:12px 0 0;color:#1f2937;font-size:15px;">SLClassroom Team</p>
</td></tr>

<tr><td style="background:#0f172a;padding:20px;text-align:center;color:#94a3b8;font-size:12px;line-height:20px;">
This is an automated email. Please do not reply. Keep your temporary password private.
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
