/**
 * Create demo user adeel@test.com / adeel123 and assign orphan expenses to them.
 * Same logic as server auto-seed in non-production.
 */
import '../src/bootEnv.js';
import mongoose from 'mongoose';

const mongoUri =
  (typeof process.env.MONGO_URI === 'string' && process.env.MONGO_URI.trim()) ||
  'mongodb://127.0.0.1:27017/paper-brain';

await mongoose.connect(mongoUri);
const { ensureDemoAccountAndLegacyExpenses, DEMO_EMAIL } = await import(
  '../src/lib/seedDemo.js'
);
await ensureDemoAccountAndLegacyExpenses();
console.log(`Done. Sign in as ${DEMO_EMAIL}`);
await mongoose.disconnect();
