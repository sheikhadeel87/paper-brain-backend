import './bootEnv.js';
import { validateProductionEnv } from './lib/validateProductionEnv.js';
import { connectMongo, getMongoUriForLogs } from './lib/mongoConnect.js';

validateProductionEnv();

const { default: app } = await import('./app.js');

const PORT = process.env.PORT || 8000;

if (!String(process.env.MONGO_URI || '').trim()) {
  console.warn(
    'MONGO_URI not set; connectMongo() will use mongodb://127.0.0.1:27017/paper-brain',
  );
}

try {
  await connectMongo();
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
} catch (err) {
  console.error('MongoDB connection failed:', err?.message || err);
  if (String(getMongoUriForLogs()).startsWith('mongodb+srv')) {
    console.error(
      'Atlas tips: Network Access must allow your IP (or 0.0.0.0/0 for testing); user/password must match the URI; special characters in the password must be URL-encoded.',
    );
  }
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
