import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true, select: false },
    plan: { type: String, enum: ['free', 'pro'], default: 'free' },
    stripeCustomerId: { type: String, default: '', index: true },
    stripeSubscriptionId: { type: String, default: '', index: true },
    subscriptionStatus: { type: String, default: 'free' },
    subscriptionCurrentPeriodEnd: { type: Date, default: null },
    /** True when the user cancelled but Stripe keeps access until `subscriptionCurrentPeriodEnd`. */
    subscriptionCancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const User = mongoose.models.User || mongoose.model('User', userSchema);
