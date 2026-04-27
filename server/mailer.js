const nodemailer = require('nodemailer');

function createTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false, // 587 uses STARTTLS
        auth: {
            user: process.env.SMTP_USER,  // Brevo login: 7a5e7d003@smtp-brevo.com
            pass: process.env.SMTP_PASS
        }
    });
}

/**
 * Send an OTP email styled to match the vFootball Mini App UI
 * @param {string} email - Destination email address
 * @param {string} otp - The OTP code
 */
async function sendOtpEmail(email, otp) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn(`[Mailer] ⚠️  SMTP not configured — Dev OTP for ${email}: ${otp}`);
        return true;
    }

    // Verified sender address — must match a domain authorised in Brevo
    const FROM_ADDRESS = process.env.SMTP_FROM || 'sportypredict@marspanel.site';
    const transporter = createTransporter();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>vFootball Verification</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background-color:#09090b;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#09090b;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:520px;background:linear-gradient(145deg,#0f0f13,#111118);border:1px solid rgba(79,70,229,0.25);border-radius:16px;overflow:hidden;">

          <!-- Header Banner -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);padding:32px 40px;text-align:center;">
              <!-- Brain SVG icon replica -->
              <div style="display:inline-block;margin-bottom:12px;">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
                  <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
                  <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
                </svg>
              </div>
              <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">vFootball AI</h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.7);font-weight:500;letter-spacing:0.5px;text-transform:uppercase;">Account Verification</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:14px;color:#a1a1aa;font-weight:500;">Hi there 👋</p>
              <h2 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.4px;">Verify your email to get started</h2>
              <p style="margin:0 0 32px;font-size:15px;color:#71717a;line-height:1.6;">
                Enter this 6-digit code in the bot to confirm your identity. This code expires in <strong style="color:#a1a1aa;">10 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background:rgba(79,70,229,0.12);border:2px solid rgba(79,70,229,0.4);border-radius:12px;padding:28px;text-align:center;margin-bottom:32px;">
                <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#818cf8;text-transform:uppercase;letter-spacing:1.5px;">Verification Code</p>
                <div style="font-size:48px;font-weight:800;color:#ffffff;letter-spacing:14px;font-variant-numeric:tabular-nums;line-height:1;">${otp}</div>
              </div>

              <!-- Info pills row -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td width="50%" style="padding-right:8px;">
                    <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:14px;text-align:center;">
                      <p style="margin:0;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">AI Provider</p>
                      <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:#a1a1aa;">Gemini / Claude</p>
                    </div>
                  </td>
                  <td width="50%" style="padding-left:8px;">
                    <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:14px;text-align:center;">
                      <p style="margin:0;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Expires In</p>
                      <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:#a1a1aa;">10 Minutes</p>
                    </div>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#52525b;line-height:1.5;">
                If you didn't request this code, you can safely ignore this email. Your account will not be created.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:12px;color:#3f3f46;text-align:center;">
                © ${new Date().getFullYear()} vFootball AI · Statistical predictions for virtual football
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const mailOptions = {
        from: `"vFootball AI" <${FROM_ADDRESS}>`,
        to: email,
        subject: '🔐 Your vFootball Verification Code',
        text: `Your vFootball verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
        html
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Mailer] ✅ OTP sent to ${email}`);
        return true;
    } catch (err) {
        console.error('[Mailer] ❌ Error sending email:', err.message);
        return false;
    }
}

module.exports = { sendOtpEmail };
