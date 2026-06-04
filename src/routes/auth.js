import express from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { signAuthToken, userJson } from '../lib/authSession.js';
import { repairUserSubscriptionPeriodEnd } from './stripe.js';
import {
  issueAndSendVerification,
  resendVerificationForEmail,
  verifyEmailWithToken,
} from '../services/auth/emailVerificationService.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const email =
    typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!name || !email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Name, email, and password are required.',
    });
  }
  if (!/^[A-Za-z]+( [A-Za-z]+)*$/.test(name)) {
    return res.status(400).json({
      success: false,
      error: 'Use alphabets and spaces only, e.g. Ahmed or Muhammad Adeel.',
    });
  }
  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 6 characters.',
    });
  }
  const exists = await User.findOne({ email });
  if (exists) {
    return res.status(409).json({
      success: false,
      error: 'An account with this email already exists.',
    });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const user = await User.create({
      name,
      email,
      password: hash,
      isVerified: false,
    });
    await issueAndSendVerification(user);
    return res.status(201).json({
      success: true,
      needsEmailVerification: true,
      email: user.email,
      message: 'Account created. Please check your email to verify your account before signing in.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    return res.status(500).json({ success: false, error: message });
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email =
      typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required.',
      });
    }
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await bcrypt.compare(password, user.password || ''))) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }
    if (user.isVerified === false) {
      return res.status(403).json({
        success: false,
        error: 'Please verify your email first.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    const token = signAuthToken(user);
    return res.json({ success: true, token, user: userJson(user) });
  } catch (err) {
    return next(err);
  }
});

router.get('/verify-email/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Verification token is required.' });
    }
    const result = await verifyEmailWithToken(token);
    return res.json({
      success: true,
      message: result.alreadyVerified
        ? 'Email was already verified. You can sign in.'
        : 'Email verified successfully. You can now sign in.',
      alreadyVerified: Boolean(result.alreadyVerified),
      email: result.email,
    });
  } catch (err) {
    const status = err.status || (err.name === 'TokenExpiredError' ? 400 : 400);
    const message =
      err.name === 'TokenExpiredError'
        ? 'Verification link has expired. Request a new one.'
        : err instanceof Error
          ? err.message
          : 'Verification failed.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.post('/resend-verification', async (req, res) => {
  try {
    const email =
      typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const result = await resendVerificationForEmail(email);
    return res.json({
      success: true,
      message: result.message,
      alreadyVerified: Boolean(result.alreadyVerified),
    });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not resend verification email.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.auth.userId)) {
      return res.status(401).json({ success: false, error: 'Invalid user.' });
    }
    let user = await User.findById(req.auth.userId)
      .select(
        'name email isVerified organizationId branchId role status plan stripeSubscriptionId subscriptionStatus subscriptionCurrentPeriodEnd subscriptionCancelAtPeriodEnd',
      )
      .lean();
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found.' });
    }
    if (
      user.plan === 'pro' &&
      user.stripeSubscriptionId &&
      !user.subscriptionCurrentPeriodEnd
    ) {
      await repairUserSubscriptionPeriodEnd(req.auth.userId);
      user = await User.findById(req.auth.userId)
        .select(
          'name email isVerified organizationId branchId role status plan subscriptionStatus subscriptionCurrentPeriodEnd subscriptionCancelAtPeriodEnd',
        )
        .lean();
    }
    return res.json({ success: true, user: userJson(user) });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to load user.' });
  }
});

export default router;
