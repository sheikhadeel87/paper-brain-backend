import { User } from '../models/User.js';

/** Requires `req.auth` and a verified email on the user record. */
export async function requireEmailVerified(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    const user = await User.findById(userId).select('isVerified').lean();
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found.' });
    }

    if (user.isVerified === false) {
      return res.status(403).json({
        success: false,
        error: 'Please verify your email first.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authorization failed.';
    return res.status(500).json({ success: false, error: message });
  }
}
