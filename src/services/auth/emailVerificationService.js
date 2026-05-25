import { User } from '../../models/User.js';
import { createEmailVerificationToken } from '../../lib/emailVerificationToken.js';
import { verifyEmailVerificationToken } from '../../lib/emailVerificationToken.js';
import { sendVerificationEmail } from '../email/sendVerificationEmail.js';
import { verificationLinkForToken } from '../../lib/frontendUrl.js';
import { isEmailConfigured } from '../email/mailer.js';

export async function issueAndSendVerification(user) {
  const token = createEmailVerificationToken(user._id, user.email);
  user.verificationToken = token;
  user.isVerified = false;
  await user.save();

  await sendVerificationEmail({
    to: user.email,
    name: user.name,
    token,
  });

  if (!isEmailConfigured() && process.env.NODE_ENV !== 'production') {
    const link = verificationLinkForToken(token);
    console.info('[auth] Dev verification link:', link);
  }

  return { email: user.email };
}

export async function verifyEmailWithToken(token) {
  const { userId, email } = verifyEmailVerificationToken(token);

  const user = await User.findOne({
    _id: userId,
    email,
  }).select('+verificationToken');

  if (!user) {
    const err = new Error('Invalid or expired verification link.');
    err.status = 400;
    throw err;
  }

  if (user.isVerified) {
    return { alreadyVerified: true, email: user.email };
  }

  if (user.verificationToken !== token) {
    const err = new Error('Invalid or expired verification link.');
    err.status = 400;
    throw err;
  }

  user.isVerified = true;
  user.verificationToken = null;
  await user.save();

  return { alreadyVerified: false, email: user.email };
}

export async function resendVerificationForEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) {
    const err = new Error('Email is required.');
    err.status = 400;
    throw err;
  }

  const user = await User.findOne({ email: normalized });
  if (!user) {
    return { sent: true, message: 'If an account exists, a verification email was sent.' };
  }

  if (user.isVerified) {
    return { sent: false, alreadyVerified: true, message: 'This email is already verified.' };
  }

  await issueAndSendVerification(user);
  return { sent: true, message: 'Verification email sent.' };
}
