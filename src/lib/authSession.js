import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './jwtSecret.js';

export function signAuthToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

export function userJson(doc) {
  const id = doc._id != null ? String(doc._id) : String(doc.id);
  return {
    id,
    email: doc.email,
    name: doc.name,
    isVerified: doc.isVerified !== false,
    organizationId: doc.organizationId ? String(doc.organizationId) : '',
    branchId: doc.branchId ? String(doc.branchId) : '',
    role: doc.role || 'ADMIN',
    status: doc.status || 'ACTIVE',
    plan: doc.plan || 'free',
    subscriptionStatus: doc.subscriptionStatus || 'free',
    subscriptionCurrentPeriodEnd: doc.subscriptionCurrentPeriodEnd || null,
    subscriptionCancelAtPeriodEnd: Boolean(doc.subscriptionCancelAtPeriodEnd),
  };
}
