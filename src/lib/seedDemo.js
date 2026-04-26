import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { Expense } from '../models/Expense.js';

export const DEMO_EMAIL = 'adeel@test.com';
export const DEMO_PASSWORD = 'adeel123';
const DEMO_NAME = 'Adeel';

const orphanFilter = {
  $or: [{ user: { $exists: false } }, { user: null }],
};

/** Ensures demo user exists and attaches orphan expenses (no `user`) to that account. */
export async function ensureDemoAccountAndLegacyExpenses() {
  let user = await User.findOne({ email: DEMO_EMAIL });
  if (!user) {
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    user = await User.create({
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      password: hash,
    });
    console.log(`[seed] Created demo user ${DEMO_EMAIL}`);
  }
  const res = await Expense.updateMany(orphanFilter, { $set: { user: user._id } });
  if (res.modifiedCount > 0) {
    console.log(
      `[seed] Linked ${res.modifiedCount} orphan expense(s) to ${DEMO_EMAIL}`,
    );
  }
}
