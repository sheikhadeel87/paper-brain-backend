/**
 * One-time: attach expenses with no `user` field to an existing account.
 * Use when data was created before per-user scoping.
 *
 * Usage (from backend/): npm run assign-legacy -- you@example.com
 */
import '../src/bootEnv.js';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Expense } from '../src/models/Expense.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run assign-legacy -- you@example.com');
  process.exit(1);
}

const mongoUri =
  (typeof process.env.MONGO_URI === 'string' && process.env.MONGO_URI.trim()) ||
  'mongodb://127.0.0.1:27017/paper-brain';

await mongoose.connect(mongoUri);
const user = await User.findOne({ email });
if (!user) {
  console.error(`No user found for email: ${email}`);
  process.exit(1);
}

const orphanFilter = {
  $or: [{ user: { $exists: false } }, { user: null }],
};
const before = await Expense.countDocuments(orphanFilter);
const res = await Expense.updateMany(orphanFilter, { $set: { user: user._id } });
console.log(
  `User: ${email} (${user._id.toString()})\n` +
    `Orphan expenses (no user): ${before}\n` +
    `Matched: ${res.matchedCount}, modified: ${res.modifiedCount}`,
);
await mongoose.disconnect();
