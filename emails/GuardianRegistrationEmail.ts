export interface GuardianRegistrationEmailProps {
  guardianName: string;
  email: string;
  password: string;
  loginLink: string;
  studentName: string;
  relation: string;
}

function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getGuardianRegistrationEmail(
  props: GuardianRegistrationEmailProps
) {
  const guardianName = escape(props.guardianName);
  const email = escape(props.email);
  const password = escape(props.password);
  const loginLink = escape(props.loginLink);
  const studentName = escape(props.studentName);
  const relation = escape(props.relation);

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Your SLClassroom Guardian Account</title>
      </head>
      <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f7fb;padding:40px 15px;">
          <tr>
            <td align="center">
              <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 12px 35px rgba(15,23,42,.08);">

                <tr>
                  <td style="background:linear-gradient(135deg,#0f2d5c,#1d4ed8,#0d9488);padding:40px;text-align:center;">
                    <div style="font-size:46px;line-height:1;">👪</div>
                    <div style="font-size:26px;font-weight:700;color:#ffffff;margin-top:12px;">
                      Guardian Account Created
                    </div>
                    <div style="color:rgba(255,255,255,.92);font-size:15px;margin-top:10px;">
                      You can now monitor your student's progress on SLClassroom.
                    </div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:36px 40px 8px;">
                    <p style="margin:0;font-size:16px;color:#1f2937;">
                      Hello <strong>${guardianName}</strong>,
                    </p>
                    <p style="margin:18px 0 0;color:#475569;font-size:15px;line-height:26px;">
                      A guardian account has been created for you as
                      <strong>${studentName}</strong>'s ${relation}. Use the
                      credentials below to sign in and follow classes, payments,
                      attendance, papers, assignments and quiz results.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td style="padding:20px 40px 8px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #1d4ed8;border-radius:14px;background:#eff6ff;">
                      <tr>
                        <td style="padding:24px 26px;">
                          <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#1e40af;font-weight:bold;">
                            Sign in with your email
                          </div>
                          <div style="margin-top:10px;font-size:16px;color:#0f172a;">
                            Email: <strong>${email}</strong>
                          </div>
                          <div style="margin-top:6px;font-size:16px;color:#0f172a;">
                            Password: <strong style="letter-spacing:1px;">${password}</strong>
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:24px 40px 8px;">
                    <a href="${loginLink}"
                      style="display:inline-block;padding:14px 38px;background:#1d4ed8;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;border-radius:10px;">
                      Log in to SLClassroom
                    </a>
                  </td>
                </tr>

                <tr>
                  <td style="padding:16px 40px 34px;">
                    <p style="margin:0;color:#64748b;font-size:13px;line-height:22px;">
                      For your security, please sign in and change your password.
                      Keep these details private — they are unique to your
                      guardian account.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td style="background:#0f172a;padding:30px;text-align:center;">
                    <div style="font-size:18px;color:#ffffff;font-weight:bold;">SLClassroom</div>
                    <div style="margin-top:8px;color:#cbd5e1;font-size:14px;">Empowering Learning Through Technology</div>
                    <p style="margin-top:18px;color:#94a3b8;font-size:12px;line-height:20px;">
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
