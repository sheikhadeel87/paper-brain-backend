import './bootEnv.js';
import { validateProductionEnv } from './lib/validateProductionEnv.js';
import mongoose from 'mongoose';

validateProductionEnv();

const { default: app } = await import('./app.js');

const PORT = process.env.PORT || 8000;
const mongoUri =
  (typeof process.env.MONGO_URI === 'string' && process.env.MONGO_URI.trim()) ||
  'mongodb://127.0.0.1:27017/paper-brain';

if (!process.env.MONGO_URI?.trim()) {
  console.warn(
    'MONGO_URI not set; using mongodb://127.0.0.1:27017/paper-brain (database: paper-brain).',
  );
}

mongoose
  .connect(mongoUri)
  .then(async () => {
    console.log('MongoDB Connected');
    if (process.env.NODE_ENV !== 'production') {
      try {
        const { ensureDemoAccountAndLegacyExpenses } = await import(
          './lib/seedDemo.js'
        );
        await ensureDemoAccountAndLegacyExpenses();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[seed] Demo account step failed:', msg);
      }
    }
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err?.message || err);
    if (String(mongoUri).startsWith('mongodb+srv')) {
      console.error(
        'Atlas tips: Network Access must allow your IP (or 0.0.0.0/0 for testing); user/password must match the URI; special characters in the password must be URL-encoded.',
      );
    }
    process.exit(1);
  });
