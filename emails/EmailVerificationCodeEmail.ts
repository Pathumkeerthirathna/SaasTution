export interface EmailVerificationCodeEmailProps {
  code: string;
  /** How long the code stays valid, e.g. "30 minutes". Optional. */
  expiresIn?: string;
}

export function getEmailVerificationCodeEmail(props: EmailVerificationCodeEmailProps) {
  const expiryNote = props.expiresIn
    ? `This code will expire in <strong>${props.expiresIn}</strong> for your security.`
    : `This code will expire soon for your security.`;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Confirm your SLClassroom email</title>
    </head>

    <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
        <tr>
          <td align="center">

            <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#059669,#16a34a,#f97316);padding:42px;text-align:center;">
                  <div style="font-size:52px;line-height:1;">✉️</div>
                  <div style="font-size:28px;font-weight:700;color:#ffffff;margin-top:12px;">
                    Confirm your email
                  </div>
                  <div style="color:rgba(255,255,255,.92);font-size:15px;margin-top:10px;">
                    Use the code below to confirm this email address belongs to you.
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
                    Enter this confirmation code to finish signing in to SLClassroom.
                    ${expiryNote}
                  </p>
                </td>
              </tr>

              <!-- Code -->
              <tr>
                <td align="center" style="padding:28px 40px 36px;">
                  <div style="display:inline-block;padding:18px 44px;background:#f0fdf4;border:2px dashed #059669;border-radius:12px;font-size:34px;font-weight:bold;letter-spacing:10px;color:#065f46;">
                    ${props.code}
                  </div>
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
                          If you did not try to sign in or register, you can safely ignore
                          this email &mdash; no changes will be made to any account.
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
