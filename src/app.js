import './bootEnv.js';
import express from 'express';
import cors from 'cors';
import { connectMongo } from './lib/mongoConnect.js';
import authRoutes from './routes/auth.js';
import receiptRoutes from './routes/receipt.js';
import expenseRoutes from './routes/expenses.js';

const app = express();

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    exposedHeaders: ['X-Process-Time-Ms'],
    origin:
      allowedOrigins.length === 0
        ? true
        : (origin, cb) => {
            if (!origin) return cb(null, true);
            if (allowedOrigins.includes(origin)) return cb(null, true);
            return cb(null, false);
          },
  }),
);
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Vercel serverless: `server.js` is not the entry, so this runs Mongo before /api.
app.use('/api', async (req, res, next) => {
  try {
    await connectMongo();
    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mongo] connect failed:', msg);
    if (String(process.env.MONGO_URI || '').includes('mongodb+srv')) {
      console.error(
        'Atlas: Network Access, URL-encoded password in MONGO_URI, and cluster host must be correct.',
      );
    }
    return res.status(503).json({
      success: false,
      error:
        'Database connection failed. Verify MONGO_URI and Atlas allowlist, then try again.',
    });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/receipt', receiptRoutes);
app.use('/api/expenses', expenseRoutes);

// Vercel returns HTML "Internal Server Error" if nothing converts thrown errors to JSON
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || err.statusCode || 500
  const message = err instanceof Error ? err.message : 'Server error'
  if (message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, error: 'Origin not allowed.' })
  }
  console.error('[app]', err)
  return res.status(status).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Server error.' : message,
  })
})

export default app;
