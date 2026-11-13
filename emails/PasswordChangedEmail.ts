/*
 * "Your password was changed" notice (Student Profile SP-7B), sent after a
 * committed password reset. Static content only: no name, link or other
 * value from the account is inserted.
 */
/** Who changed it: the student through a reset link (SP-7B, default) or their teacher (SP-7D). Fixed wording only. */
export type PasswordChangedBy = "reset-link" | "teacher";

const CHANGED_HOW: Record<PasswordChangedBy, string> = {
  "reset-link": "was just changed using a password reset link",
  teacher: "was just reset by your teacher",
};

const NOT_YOU: Record<PasswordChangedBy, string> = {
  "reset-link": "If you did not reset your password, contact your teacher immediately",
  teacher: "If you did not ask your teacher for a new password, contact your teacher immediately",
};

export function passwordChangedText(by: PasswordChangedBy = "reset-link") {
  return `The password for your SLClassroom account ${CHANGED_HOW[by]}. You have been signed out on every device; sign in again with your new password.\n\n${NOT_YOU[by]}.`;
}

export function getPasswordChangedEmail(by: PasswordChangedBy = "reset-link") {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Your SLClassroom password was changed</title>
    </head>

    <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
        <tr>
          <td align="center">

            <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#059669,#16a34a,#f97316);padding:42px;text-align:center;">
                  <div style="font-size:52px;line-height:1;">🔐</div>
                  <div style="font-size:28px;font-weight:700;color:#ffffff;margin-top:12px;">
                    Your password was changed
                  </div>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:40px 40px 10px;">
                  <p style="margin:0;font-size:16px;color:#1f2937;">
                    Hello,
                  </p>
                  <p style="margin:18px 0 0;color:#475569;font-size:15px;line-height:28px;">
                    The password for your SLClassroom account ${CHANGED_HOW[by]}.
                    For your security, you have been signed out on every device. Sign in again with your new password.
                  </p>
                </td>
              </tr>

              <!-- Security note -->
              <tr>
                <td style="padding:24px 40px 36px;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e5e7eb;">
                    <tr>
                      <td style="padding:22px 24px;">
                        <div style="font-size:16px;font-weight:bold;color:#111827;">
                          🛡️ Didn't do this?
                        </div>
                        <p style="margin:10px 0 0;color:#4b5563;line-height:26px;font-size:14px;">
                          ${NOT_YOU[by]}
                          so your account can be secured.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background:#0f172a;padding:32px;text-align:center;">
                  <div style="font-size:20px;color:#ffffff;font-weight:bold;">
                    SLClassroom
                  </div>
                  <div style="margin-top:10px;color:#cbd5e1;font-size:14px;">
                    Empowering Learning Through Technology
                  </div>
                  <p style="margin-top:22px;color:#94a3b8;font-size:12px;line-height:22px;">
                    This is an automated email. Please do not reply.
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
