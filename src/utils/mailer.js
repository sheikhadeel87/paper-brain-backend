import nodemailer from 'nodemailer';

let transporter = null;

export function isSmtpConfigured() {
  return Boolean(
    String(process.env.SMTP_HOST || '').trim() &&
      String(process.env.SMTP_USER || '').trim() &&
      String(process.env.SMTP_PASS || '').trim(),
  );
}

function getTransporter() {
  if (!isSmtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: String(process.env.SMTP_HOST || '').trim(),
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: {
        user: String(process.env.SMTP_USER || '').trim(),
        pass: String(process.env.SMTP_PASS || '').trim(),
      },
    });
  }
  return transporter;
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} mail
 */
export async function sendMail({ to, subject, text, html }) {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[smtp] SMTP env not configured; email skipped:', { to, subject, text });
      return { skipped: true };
    }
    throw new Error('SMTP email is not configured.');
  }

  const from =
    String(process.env.SMTP_FROM || '').trim() ||
    String(process.env.SMTP_USER || '').trim();

  await transport.sendMail({
    from: `Paper Brain <${from}>`,
    to,
    subject,
    text,
    html,
  });
  return { sent: true };
}
