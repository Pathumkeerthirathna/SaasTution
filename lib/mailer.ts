import nodemailer from "nodemailer";

import { AppError } from "@/lib/error-handler";
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
  const secure = secureValue ? secureValue === "true" : port === 465;

  console.log("SMTP Config:", {
    host,
    port,
    secure,
    user,
    from: process.env.SMTP_FROM,
  });

  if (!host || !user || !pass) {
    console.error("SMTP configuration is incomplete.");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure:true,
    auth: {
      user,
      pass,
    },
    logger: true,
    debug: true,
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
    "Reset your SaasTution password",
    `
      <p>Use this link to reset your password:</p>

      <p>
        <a href="${input.resetLink}">
          ${input.resetLink}
        </a>
      </p>

      <p>If you did not request this, please ignore this email.</p>
    `,
    `Use this link to reset your password:\n${input.resetLink}`
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