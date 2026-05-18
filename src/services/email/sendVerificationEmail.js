import { verificationLinkForToken } from '../../lib/frontendUrl.js';
import { sendMail } from './mailer.js';

export async function sendVerificationEmail({ to, name, token }) {
  const verifyUrl = verificationLinkForToken(token);
  const displayName = name?.trim() || 'there';

  const subject = 'Verify your Paper Brain email';
  const text = `Hi ${displayName},

Thanks for signing up for Paper Brain. Please verify your email by opening this link (valid for 24 hours):

${verifyUrl}

If you did not create an account, you can ignore this email.

— Paper Brain`;

  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b;max-width:480px">
  <h2 style="color:#7c3aed;margin:0 0 12px">Verify your email</h2>
  <p>Hi ${displayName},</p>
  <p>Thanks for signing up for <strong>Paper Brain</strong>. Click the button below to verify your email (link expires in 24 hours).</p>
  <p style="margin:28px 0">
    <a href="${verifyUrl}" style="background:#7c3aed;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Verify email</a>
  </p>
  <p style="font-size:13px;color:#71717a">Or copy this link:<br/><a href="${verifyUrl}">${verifyUrl}</a></p>
  <p style="font-size:13px;color:#71717a">If you did not create an account, you can ignore this message.</p>
</div>`;

  return sendMail({ to, subject, text, html });
}
