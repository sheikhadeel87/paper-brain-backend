import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './jwtSecret.js';

const PURPOSE = 'email-verify';
const EXPIRES_IN = '1d';

export function createEmailVerificationToken(userId, email) {
  return jwt.sign(
    {
      purpose: PURPOSE,
      sub: String(userId),
      email: String(email).trim().toLowerCase(),
    },
    JWT_SECRET,
    { expiresIn: EXPIRES_IN },
  );
}

export function verifyEmailVerificationToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload?.purpose !== PURPOSE) {
    throw new Error('Invalid verification token.');
  }
  const email =
    typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const userId = payload.sub != null ? String(payload.sub) : '';
  if (!email || !userId) {
    throw new Error('Invalid verification token.');
  }
  return { userId, email };
}
