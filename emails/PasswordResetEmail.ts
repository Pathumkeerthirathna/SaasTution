export interface PasswordResetEmailProps {
  resetLink: string;
  /** How long the link stays valid, e.g. "1 hour". Optional. */
  expiresIn?: string;
}

export function getPasswordResetEmail(props: PasswordResetEmailProps) {
  const expiryNote = props.expiresIn
    ? `This link will expire in <strong>${props.expiresIn}</strong> for your security.`
    : `This link will expire soon for your security.`;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Reset your SLClassroom password</title>
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
                    Reset your password
                  </div>
                  <div style="color:rgba(255,255,255,.92);font-size:15px;margin-top:10px;">
                    We received a request to reset your SLClassroom password.
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
                    Click the button below to choose a new password for your account.
                    ${expiryNote}
                  </p>
                </td>
              </tr>

              <!-- CTA -->
              <tr>
                <td align="center" style="padding:28px 40px 36px;">
                  <a href="${props.resetLink}"
                    style="display:inline-block;padding:16px 44px;background:#059669;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;border-radius:10px;">
                    Reset Password
                  </a>
                </td>
              </tr>

              <!-- Security note -->
              <tr>
                <td style="padding:0 40px 36px;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e5e7eb;">
                    <tr>
                      <td style="padding:22px 24px;">
                        <div style="font-size:16px;font-weight:bold;color:#111827;">
                          🛡️ Didn't request this?
                        </div>
                        <p style="margin:10px 0 0;color:#4b5563;line-height:26px;font-size:14px;">
                          If you did not ask to reset your password, you can safely ignore
                          this email &mdash; your password will not be changed.
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
                  <div style="margin-top:18px;">
                    <a href="https://slclassroom.live" style="color:#34d399;text-decoration:none;font-weight:bold;">
                      https://slclassroom.live
                    </a>
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
