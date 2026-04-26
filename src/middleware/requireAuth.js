import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../lib/jwtSecret.js';

/** Attaches `req.auth` = `{ userId, email, name }` from a valid Bearer JWT. */
export function requireAuth(req, res, next) {
  const raw = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  if (!m) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    const sub = payload.sub;
    if (!sub) {
      return res.status(401).json({ success: false, error: 'Invalid token.' });
    }
    req.auth = {
      userId: String(sub),
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : '',
    };
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
}
