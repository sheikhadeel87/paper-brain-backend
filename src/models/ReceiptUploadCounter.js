import mongoose from 'mongoose';

/** Per-user UTC-day receipt upload count (Free tier quota). */
const receiptUploadCounterSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** `YYYY-MM-DD` in UTC */
    day: { type: String, required: true, index: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

receiptUploadCounterSchema.index({ user: 1, day: 1 }, { unique: true });

export const ReceiptUploadCounter =
  mongoose.models.ReceiptUploadCounter ||
  mongoose.model('ReceiptUploadCounter', receiptUploadCounterSchema);
