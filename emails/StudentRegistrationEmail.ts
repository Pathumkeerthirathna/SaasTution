export interface StudentRegistrationEmailProps {
  studentName: string;
  registrationNumber: string;
  teacherName: string;
  className: string;
  registrationDate: string;
}

export function getStudentRegistrationEmail(
  props: StudentRegistrationEmailProps
) {
  return `
    <!DOCTYPE html>

        <html lang="en">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Welcome to SLClassroom</title>
        </head>

        <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
        <tr>
        <td align="center">

        <table role="presentation" cellpadding="0" cellspacing="0" width="650" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

        <!-- Header -->

        <tr>
        <td style="background:linear-gradient(135deg,#059669,#16a34a,#f97316);padding:42px;text-align:center;">

        <div style="font-size:52px;line-height:1;">🎓</div>

        <div style="font-size:30px;font-weight:700;color:#ffffff;margin-top:12px;">
        Welcome to SLClassroom
        </div>

        <div style="color:rgba(255,255,255,.92);font-size:16px;margin-top:10px;">
        Your registration has been completed successfully.
        </div>

        </td>
        </tr>

        <!-- Greeting -->

        <tr>
        <td style="padding:40px;">

        <p style="margin:0;font-size:17px;color:#1f2937;">
        Hello <strong>{{StudentName}}</strong>,
        </p>

        <p style="margin:20px 0 0;color:#475569;font-size:15px;line-height:28px;">
        Congratulations! We are delighted to welcome you to <strong>SLClassroom</strong>.
        Your registration has been successfully completed, and your student account is now ready.
        </p>

        <p style="margin:18px 0 0;color:#475569;font-size:15px;line-height:28px;">
        Please keep your registration number in a safe place. It serves as your unique student identification number and may be required when communicating with your teacher or accessing student services.
        </p>

        </td>
        </tr>

        <!-- Registration Card -->

        <tr>
        <td style="padding:0 40px 35px;">

        <table width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #16a34a;border-radius:14px;background:#f0fdf4;">

        <tr>
        <td align="center" style="padding:28px;">

        <div style="font-size:42px;">🪪</div>

        <div style="margin-top:12px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#166534;font-weight:bold;">
        Registration Number
        </div>

        <div style="margin-top:12px;font-size:32px;font-weight:bold;color:#f97316;letter-spacing:2px;">
        {{RegistrationNumber}}
        </div>

        </td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- Information -->

        <tr>
        <td style="padding:0 40px 30px;">

        <table width="100%" cellpadding="12" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;">

        <tr style="background:#f8fafc;">
        <td><strong>👤 Student</strong></td>
        <td>{{StudentName}}</td>
        </tr>

        <tr>
        <td><strong>👨‍🏫 Teacher</strong></td>
        <td>{{TeacherName}}</td>
        </tr>

        <tr style="background:#f8fafc;">
        <td><strong>📚 Class</strong></td>
        <td>{{ClassName}}</td>
        </tr>

        <tr>
        <td><strong>📅 Registration Date</strong></td>
        <td>{{RegistrationDate}}</td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- Login Instructions -->

        <tr>
        <td style="padding:0 40px 35px;">

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border:1px solid #fdba74;border-radius:14px;">

        <tr>
        <td style="padding:28px;">

        <div style="font-size:22px;font-weight:bold;color:#9a3412;">
        🚀 How to Access Your SLClassroom Account
        </div>

        <p style="margin-top:14px;color:#444;line-height:26px;font-size:15px;">
        Your account has been created successfully. Before you can sign in for the first time, please complete the steps below.
        </p>

        <ol style="padding-left:20px;margin:18px 0 0;color:#444;line-height:29px;font-size:15px;">

        <li><strong>Open SLClassroom</strong><br/>
        Visit <strong>https://slclassroom.live/login</strong>.
        </li>

        <li style="margin-top:10px;"><strong>Reset your password</strong><br/>
        On the login page, click <strong>"Forgot Password"</strong>, enter the Registration Number provided above, and request a password reset link.
        </li>

        <li style="margin-top:10px;"><strong>Set your password</strong><br/>
        Check your registered email for the password reset email. Open the reset link, create a strong password, and click <strong>"Reset password"</strong> — then click <strong>"Sign in"</strong>.
        </li>

        <li style="margin-top:10px;"><strong>Sign in with your Registration Number</strong><br/>
        Registration Number: <strong>{{RegistrationNumber}}</strong><br/>
        Password: the password you just created.
        </li>

        <li style="margin-top:10px;"><strong>Enter your confirmation code</strong><br/>
        After signing in, SLClassroom will ask for a confirmation code — check your inbox for a <strong>separate</strong> confirmation-code email and enter the code shown there.
        </li>

        <li style="margin-top:10px;"><strong>Wait for device approval</strong><br/>
        You will then see a Device Approval request. Once your teacher approves your device, you can sign in and start using your SLClassroom account.
        </li>

        </ol>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;">
        <tr>
        <td style="padding:16px 18px;">

        <div style="font-size:14px;font-weight:bold;color:#1e3a8a;">
        📌 Two different emails, two different codes
        </div>

        <p style="margin-top:8px;color:#334155;line-height:24px;font-size:14px;">
        <strong>This email</strong> contains your <strong>Registration Number</strong> — used to sign in.<br/>
        A <strong>separate</strong> confirmation-code email contains your <strong>Confirmation Code</strong> — used only to verify your sign-in. It is not the same as your Registration Number.
        </p>

        </td>
        </tr>
        </table>

        <p style="margin-top:16px;color:#6b7280;font-size:13px;line-height:22px;">
        Can't find one of these emails? Please check your Spam/Junk folder.
        </p>

        </td>
        </tr>

        </table>

        </td>
        </tr>

        <!-- CTA -->

        <tr>
        <td align="center" style="padding:0 40px 40px;">

        <a href="https://slclassroom.live"
        style="
        display:inline-block;
        padding:16px 40px;
        background:#059669;
        color:#ffffff;
        font-size:16px;
        font-weight:bold;
        text-decoration:none;
        border-radius:10px;">
        Visit SLClassroom </a>

        </td>
        </tr>

        <!-- Security -->

        <tr>
        <td style="padding:0 40px 35px;">

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e5e7eb;">

        <tr>
        <td style="padding:24px;">

        <div style="font-size:18px;font-weight:bold;color:#111827;">
        🛡️ Keep Your Registration Number Secure
        </div>

        <p style="margin-top:12px;color:#4b5563;line-height:28px;font-size:15px;">
        Your registration number is unique to your account. Please keep it confidential and store it safely for future reference. You may be asked to provide it when receiving support or verifying your student account.
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
        This is an automated email confirming your successful registration with SLClassroom.<br/>
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
    .replace(/{{StudentName}}/g, props.studentName)
    .replace(/{{RegistrationNumber}}/g, props.registrationNumber)
    .replace(/{{TeacherName}}/g, props.teacherName)
    .replace(/{{ClassName}}/g, props.className)
    .replace(/{{RegistrationDate}}/g, props.registrationDate);
}