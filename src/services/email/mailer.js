import nodemailer from 'nodemailer';

let transporter = null;

export function isEmailConfigured() {
  return Boolean(
    String(process.env.EMAIL_USER || '').trim() &&
      String(process.env.EMAIL_PASS || '').trim(),
  );
}

function getTransporter() {
  if (!isEmailConfigured()) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER.trim(),
        pass: process.env.EMAIL_PASS.trim(),
      },
    });
  }
  return transporter;
}

/**
 * @param {{ to: string, subject: string, text: string, html: string }} mail
 */
export async function sendMail({ to, subject, text, html }) {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[email] EMAIL_USER / EMAIL_PASS not set — message not sent:', {
        to,
        subject,
        text,
      });
      return { skipped: true };
    }
    throw new Error('Email is not configured on the server.');
  }

  const from = process.env.EMAIL_FROM?.trim() || process.env.EMAIL_USER.trim();
  await transport.sendMail({
    from: `Paper Brain <${from}>`,
    to,
    subject,
    text,
    html,
  });
  return { sent: true };
}
