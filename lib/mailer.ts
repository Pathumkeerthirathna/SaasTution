import nodemailer from "nodemailer";

import { AppError } from "@/lib/error-handler";
import { getPasswordResetEmail } from "@/emails/PasswordResetEmail";
import { getStudentRegistrationEmail, StudentRegistrationEmailProps } from "@/emails/StudentRegistrationEmail";

type PasswordResetEmailInput = {
  to: string;
  resetLink: string;
};

type LiveSessionInviteEmailInput = {
  to: string;
  studentName: string;
  className: string;
  teacherName: string;
  loginLink: string;
  notificationType?: "started" | "restarted";
};

function getBaseUrl() {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.DEPLOY_URL,
    process.env.NETLIFY_URL,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();

    if (!value) {
      continue;
    }

    if (value.startsWith("http://") || value.startsWith("https://")) {
      return value;
    }

    return `https://${value}`;
  }

  return "http://localhost:3000";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// function createTransport() {
//   const host = process.env.SMTP_HOST?.trim();
//   const port = Number(process.env.SMTP_PORT || "587");
//   const user = process.env.SMTP_USER?.trim();
//   const pass = process.env.SMTP_PASS?.trim();
//   const secureValue = process.env.SMTP_SECURE?.trim().toLowerCase();
//   const secure = secureValue ? secureValue === "true" : port === 465;

//   if (!host || !user || !pass) {
//     return null;
//   }

//   return nodemailer.createTransport({
//     host,
//     port,
//     secure,
//     auth: {
//       user,
//       pass,
//     },
//   });
// }

function createTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const secureValue = process.env.SMTP_SECURE?.trim().toLowerCase();
  // Implicit TLS on 465; STARTTLS (secure:false) on 587/25 unless SMTP_SECURE says otherwise.
  const secure = secureValue ? secureValue === "true" : port === 465;

  if (!host || !user || !pass) {
    console.error("SMTP configuration is incomplete.");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });
}

export function buildPasswordResetLink(token: string, appBaseUrl?: string) {
  const baseUrl = appBaseUrl?.trim() || getBaseUrl();
  const url = new URL("/reset-password/confirm", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function buildLiveSessionInviteLoginLink(inviteToken: string, appBaseUrl?: string) {
  const baseUrl = appBaseUrl?.trim() || getBaseUrl();
  const url = new URL("/login", baseUrl);
  url.searchParams.set("invite", inviteToken);
  return url.toString();
}

// export async function sendPasswordResetEmail(input: PasswordResetEmailInput) {
//   const from = process.env.SMTP_FROM?.trim() || "no-reply@saastution.local";
//   const transporter = createTransport();

//   if (!transporter) {
//     if (process.env.NODE_ENV === "production") {
//       throw new AppError("Password reset email service is not configured.", 500, "EMAIL_NOT_CONFIGURED");
//     }

//     console.info("[DEV ONLY] Password reset link", {
//       to: input.to,
//       resetLink: input.resetLink,
//     });
//     return;
//   }

//   await transporter.sendMail({
//     from,
//     to: input.to,
//     subject: "Reset your SaasTution password",
//     text: `Use this link to reset your password: ${input.resetLink}\n\nIf you did not request this, please ignore this email.`,
//     html: `<p>Use this link to reset your password:</p><p><a href="${input.resetLink}">${input.resetLink}</a></p><p>If you did not request this, please ignore this email.</p>`,
//   });
// }

// export async function sendPasswordResetEmail(
//   input: PasswordResetEmailInput
// ) {
//   const from =
//     process.env.SMTP_FROM?.trim() || "no-reply@saastution.local";

//   const transporter = createTransport();

//   if (!transporter) {
//     if (process.env.NODE_ENV === "production") {
//       throw new AppError(
//         "Password reset email service is not configured.",
//         500,
//         "EMAIL_NOT_CONFIGURED"
//       );
//     }

//     console.info("[DEV ONLY] Password reset link", {
//       to: input.to,
//       resetLink: input.resetLink,
//     });
//     return;
//   }

//   try {
    
//     await transporter.verify();
//     console.log("✅ SMTP connection verified");

//     const info = await transporter.sendMail({
//       from,
//       to: input.to,
//       subject: "Reset your SaasTution password",
//       text: `Use this link to reset your password: ${input.resetLink}\n\nIf you did not request this, please ignore this email.`,
//       html: `
//         <p>Use this link to reset your password:</p>
//         <p><a href="${input.resetLink}">${input.resetLink}</a></p>
//         <p>If you did not request this, please ignore this email.</p>
//       `,
//     });

//     console.log("✅ Email sent successfully");
//     console.log(info);
//   } catch (error) {
//     console.error("❌ Failed to send password reset email");
//     console.error(error);

//     throw error;
//   }
// }

// export async function sendLiveSessionInviteEmail(input: LiveSessionInviteEmailInput) {
//   const from = process.env.SMTP_FROM?.trim() || "no-reply@saastution.local";
//   const transporter = createTransport();

//   if (!transporter) {
//     if (process.env.NODE_ENV === "production") {
//       throw new AppError("Live session email service is not configured.", 500, "EMAIL_NOT_CONFIGURED");
//     }

//     console.info("[DEV ONLY] Live session invite", {
//       to: input.to,
//       loginLink: input.loginLink,
//       className: input.className,
//       teacherName: input.teacherName,
//     });
//     return;
//   }

//   const safeStudentName = escapeHtml(input.studentName);
//   const safeClassName = escapeHtml(input.className);
//   const safeTeacherName = escapeHtml(input.teacherName);
//   const safeLoginLink = escapeHtml(input.loginLink);
//   const notificationType = input.notificationType ?? "started";
//   const actionText = notificationType === "restarted" ? "restarted" : "started";

//   await transporter.sendMail({
//     from,
//     to: input.to,
//     subject: `Live class ${actionText}: ${input.className}`,
//     text: `Hi ${input.studentName},\n\n${input.teacherName} has ${actionText} a live class for ${input.className}.\n\nOpen this secure link, sign in with your registration number and password, and you will be auto-joined to the classroom:\n${input.loginLink}\n\nIf this wasn't expected, please contact your teacher.`,
//     html: `<p>Hi ${safeStudentName},</p><p><strong>${safeTeacherName}</strong> has ${actionText} a live class for <strong>${safeClassName}</strong>.</p><p>Open this secure link, sign in with your registration number and password, and you will be auto-joined to the classroom:</p><p><a href="${safeLoginLink}">${safeLoginLink}</a></p><p>If this was not expected, please contact your teacher.</p>`,
//   });
// }

type ClassAnnouncementEmailInput = {
  to: string;
  studentName: string;
  className: string;
  content: string;
};

// export async function sendClassAnnouncementEmail(input: ClassAnnouncementEmailInput) {
//   const from = process.env.SMTP_FROM?.trim() || "no-reply@saastution.local";
//   const transporter = createTransport();

//   if (!transporter) {
//     if (process.env.NODE_ENV === "production") {
//       throw new AppError("Email service is not configured.", 500, "EMAIL_NOT_CONFIGURED");
//     }

//     console.info("[DEV ONLY] Class announcement email", {
//       to: input.to,
//       className: input.className,
//       content: input.content,
//     });
//     return;
//   }

//   const safeStudentName = escapeHtml(input.studentName);
//   const safeClassName = escapeHtml(input.className);
//   const safeContent = escapeHtml(input.content).replace(/\n/g, "<br>");

//   await transporter.sendMail({
//     from,
//     to: input.to,
//     subject: `Announcement: ${input.className}`,
//     text: `Hi ${input.studentName},\n\nYour teacher has sent an announcement for ${input.className}:\n\n${input.content}`,
//     html: `<p>Hi ${safeStudentName},</p><p>Your teacher has sent an announcement for <strong>${safeClassName}</strong>:</p><blockquote style="border-left:3px solid #ccc;padding:0 1em;margin:1em 0;">${safeContent}</blockquote>`,
//   });
// }

// export async function sendEmail(
//   to: string,
//   subject: string,
//   html: string
// ) {
//   const from =
//     process.env.SMTP_FROM?.trim() || "no-reply@saastution.local";

//   const transporter = createTransport();

//   if (!transporter) {
//     if (process.env.NODE_ENV === "production") {
//       throw new AppError(
//         "Email service is not configured.",
//         500,
//         "EMAIL_NOT_CONFIGURED"
//       );
//     }

//     console.info("[DEV ONLY] Email", {
//       to,
//       subject,
//       html,
//     });

//     return;
//   }

//   try {
//     await transporter.verify();
//     console.log("✅ SMTP connection verified");

//     const info = await transporter.sendMail({
//       from,
//       to,
//       subject,
//       html,
//       text: html.replace(/<[^>]*>/g, ""), // Optional plain text version
//     });

//     console.log("✅ Email sent successfully");
//     console.log(info);

//     return info;
//   } catch (error) {
//     console.error("❌ Failed to send email");
//     console.error(error);

//     throw error;
//   }
// }

//////


export async function sendClassAnnouncementEmail(
  input: ClassAnnouncementEmailInput
) {
  const safeStudentName = escapeHtml(input.studentName);
  const safeClassName = escapeHtml(input.className);
  const safeContent = escapeHtml(input.content).replace(/\n/g, "<br>");

  await sendEmail(
    input.to,
    `Announcement: ${input.className}`,
    `
      <p>Hi ${safeStudentName},</p>

      <p>
        Your teacher has sent an announcement for
        <strong>${safeClassName}</strong>.
      </p>

      <blockquote
        style="border-left:3px solid #ccc;padding-left:15px;">
        ${safeContent}
      </blockquote>
    `,
    `Hi ${input.studentName}

Your teacher has sent an announcement for ${input.className}

${input.content}`
  );
}

export async function sendLiveSessionInviteEmail(
  input: LiveSessionInviteEmailInput
) {
  const notificationType = input.notificationType ?? "started";
  const actionText =
    notificationType === "restarted"
      ? "restarted"
      : "started";

  const safeStudentName = escapeHtml(input.studentName);
  const safeTeacherName = escapeHtml(input.teacherName);
  const safeClassName = escapeHtml(input.className);
  const safeLoginLink = escapeHtml(input.loginLink);

  await sendEmail(
    input.to,
    `Live class ${actionText}: ${input.className}`,
    `
      <p>Hi ${safeStudentName},</p>

      <p>
        <strong>${safeTeacherName}</strong> has
        ${actionText} a live class for
        <strong>${safeClassName}</strong>.
      </p>

      <p>
        <a href="${safeLoginLink}">
          Join Live Class
        </a>
      </p>

      <p>
        If this was not expected, please contact your teacher.
      </p>
    `,
    `Hi ${input.studentName},

${input.teacherName} has ${actionText} a live class for ${input.className}.

${input.loginLink}`
  );
}

export async function sendPasswordResetEmail(
  input: PasswordResetEmailInput
) {
  await sendEmail(
    input.to,
    "Reset your SLClassroom password",
    getPasswordResetEmail({ resetLink: input.resetLink, expiresIn: "30 minutes" }),
    `Reset your SLClassroom password by opening this link:\n${input.resetLink}\n\nIf you did not request this, you can ignore this email.`
  );
}

export async function sendStudentRegistrationEmail(
  input: StudentRegistrationEmailProps & { to: string }
) {
  return sendEmail(
    input.to,
    "Welcome to SLClassroom",
    getStudentRegistrationEmail(input)
  );
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string
) {
  const from =
    process.env.SMTP_FROM?.trim() || "no-reply@saastution.local";

  const transporter = createTransport();

  if (!transporter) {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(
        "Email service is not configured.",
        500,
        "EMAIL_NOT_CONFIGURED"
      );
    }

    console.info("[DEV ONLY] Email", {
      to,
      subject,
    });

    return;
  }

  try {
    await transporter.verify();

    return await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text: text ?? html.replace(/<[^>]+>/g, ""),
    });
  } catch (error) {
    console.error("❌ Failed to send email", error);
    throw error;
  }
}

//////
// Class-started notification broadcast (absent students)
//////

type ClassStartedNotificationRecipient = {
  email: string | null;
  displayName: string;
};

export type ClassStartedNotificationResult = {
  email: string;
  displayName: string;
  success: boolean;
  error?: string;
};

function buildClassStartedNotificationEmail(input: {
  studentName: string;
  message: string;
}) {
  const safeStudentName = escapeHtml(input.studentName);
  const safeMessage = escapeHtml(input.message).replace(
    /\n/g,
    "<br>"
  );

  const html = `
    <div style="background:#f1f5f9;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;">

        <div style="background:#111827;padding:22px 24px;border-radius:14px 14px 0 0;text-align:center;">
          <span style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:0.3px;">
            SL Classroom
          </span>
        </div>

        <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:28px 24px;">

          <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#3b82f6;text-transform:uppercase;letter-spacing:0.5px;">
            Class Started Notification
          </p>

          <p style="margin:0 0 16px;font-size:15px;color:#0f172a;">
            Hi ${safeStudentName},
          </p>

          <div style="font-size:15px;line-height:1.6;color:#334155;">
            ${safeMessage}
          </div>

          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />

          <p style="margin:0;font-size:12px;color:#94a3b8;">
            This is an automated notification from SL Classroom. Please do not reply to this email.
          </p>

        </div>

      </div>
    </div>
  `;

  const text = `Hi ${input.studentName},\n\n${input.message}`;

  return { html, text };
}

async function sendEmailWithRetry(
  to: string,
  subject: string,
  html: string,
  text: string,
  maxAttempts = 3
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendEmail(to, subject, html, text);
      return;
    } catch (error) {
      lastError = error;

      console.error(
        `❌ Class-started notification attempt ${attempt}/${maxAttempts} failed for ${to}`,
        error
      );

      if (attempt < maxAttempts) {
        const delayMs = attempt * 1000;
        await new Promise((resolve) =>
          setTimeout(resolve, delayMs)
        );
      }
    }
  }

  throw lastError;
}

/**
 * Sends "class started" notification emails to a list of students one at a
 * time (not in parallel), retrying each recipient a few times before giving
 * up on it. A failure on one recipient never stops the rest of the batch —
 * every recipient is attempted, and a per-recipient result is returned so
 * the caller can see exactly who did and didn't get notified.
 */
export async function sendClassStartedNotifications(
  recipients: ClassStartedNotificationRecipient[],
  message: string
): Promise<ClassStartedNotificationResult[]> {
  const subject = "SL Classroom - Class Started Notification";

  const results: ClassStartedNotificationResult[] = [];

  for (const recipient of recipients) {
    const email = recipient.email?.trim();

    if (!email) {
      results.push({
        email: "",
        displayName: recipient.displayName,
        success: false,
        error: "Missing email address.",
      });

      continue;
    }

    const { html, text } = buildClassStartedNotificationEmail({
      studentName: recipient.displayName,
      message,
    });

    try {
      await sendEmailWithRetry(email, subject, html, text);

      results.push({
        email,
        displayName: recipient.displayName,
        success: true,
      });

      console.log(
        `✅ Class-started notification sent to ${email}`
      );
    } catch (error) {
      results.push({
        email,
        displayName: recipient.displayName,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error.",
      });

      console.error(
        `❌ Giving up on class-started notification to ${email} after retries`,
        error
      );
    }
  }

  const successCount = results.filter(
    (result) => result.success
  ).length;

  console.log(
    `📧 Class-started notifications complete: ${successCount}/${results.length} sent.`
  );

  return results;
}