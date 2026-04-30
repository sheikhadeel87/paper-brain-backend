import mongoose from 'mongoose';

const receiptItemSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    price: { type: Number, default: null },
    qty: { type: Number, default: null },
    unitPrice: { type: Number, default: null },
  },
  { _id: false },
);

const receiptSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** Set when the user confirms an expense from this draft. */
    expense: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Expense',
      default: null,
    },
    vendor: { type: String, default: null },
    total: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    date: { type: Date, default: null },
    tax: { type: Number, default: null },
    items: { type: [receiptItemSchema], default: [] },
    rawText: { type: String, default: '' },
    confidence: { type: Number, default: 0 },
    needsReview: { type: Boolean, default: true },
    /** True when structured AI parsing failed; row still has OCR rawText. */
    aiParseFailed: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
  },
);

receiptSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    if (ret._id) {
      ret.id = ret._id.toString();
      delete ret._id;
    }
    if (ret.date instanceof Date) {
      ret.date = ret.date.toISOString().slice(0, 10);
    }
    if (ret.expense != null) ret.expense = ret.expense.toString();
    return ret;
  },
});

export const Receipt =
  mongoose.models.Receipt || mongoose.model('Receipt', receiptSchema);
