import express from 'express';
import cors from 'cors';
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

app.use('/api/auth', authRoutes);
app.use('/api/receipt', receiptRoutes);
app.use('/api/expenses', expenseRoutes);

export default app;
