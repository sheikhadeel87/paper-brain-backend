import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { JWT_SECRET } from '../lib/jwtSecret.js';

const router = express.Router();

function signToken(user) {
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

function userJson(doc) {
  const id = doc._id != null ? String(doc._id) : String(doc.id);
  return { id, email: doc.email, name: doc.name };
}

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
    const user = await User.create({ name, email, password: hash });
    const token = signToken(user);
    return res.status(201).json({
      success: true,
      token,
      user: userJson(user),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    return res.status(500).json({ success: false, error: message });
  }
});

router.post('/login', async (req, res) => {
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
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ success: false, error: 'Invalid email or password.' });
  }
  const token = signToken(user);
  return res.json({ success: true, token, user: userJson(user) });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.auth.userId)) {
      return res.status(401).json({ success: false, error: 'Invalid user.' });
    }
    const user = await User.findById(req.auth.userId).select('name email').lean();
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found.' });
    }
    return res.json({ success: true, user: userJson(user) });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to load user.' });
  }
});

export default router;
