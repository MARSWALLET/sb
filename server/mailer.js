const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: parseInt(process.env.SMTP_PORT || '465') === 465, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

/**
 * Send an OTP email to the user
 * @param {string} email - Destination email address
 * @param {string} otp - The OTP code
 */
async function sendOtpEmail(email, otp) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn(`[Mailer] SMTP credentials not fully configured. Would have sent OTP ${otp} to ${email}`);
        return true; // We return true for dev environments without SMTP so we don't block
    }

    const mailOptions = {
        from: `"vFootball AI" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'vFootball Registration OTP',
        text: `Your vFootball registration code is: ${otp}\nThis code expires in 10 minutes.`,
        html: `
            <div style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
                <div style="max-width: 600px; margin: auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
                    <h2 style="color: #333333; text-align: center;">Welcome to vFootball AI!</h2>
                    <p style="font-size: 16px; color: #555555; text-align: center;">
                        Use the verification code below to complete your registration.
                    </p>
                    <div style="margin: 30px 0; padding: 20px; background-color: #f1f5fb; font-size: 28px; font-weight: bold; text-align: center; color: #1e3a8a; letter-spacing: 5px; border-radius: 6px;">
                        ${otp}
                    </div>
                    <p style="font-size: 14px; color: #888888; text-align: center;">
                        This code will expire in 10 minutes. If you did not request this, please ignore this email.
                    </p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (err) {
        console.error('[Mailer] Error sending email:', err);
        return false;
    }
}

module.exports = {
    sendOtpEmail
};
