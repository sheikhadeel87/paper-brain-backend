import mongoose from 'mongoose';
import {
  DEFAULT_RECEIPT_CATEGORY,
  RECEIPT_CATEGORIES,
  RECEIPT_CATEGORY_SOURCES,
} from '../lib/receiptCategories.js';

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
    category: {
      type: String,
      enum: RECEIPT_CATEGORIES,
      default: DEFAULT_RECEIPT_CATEGORY,
    },
    categorySource: {
      type: String,
      enum: RECEIPT_CATEGORY_SOURCES,
      default: 'AI',
    },
    categoryConfidence: { type: Number, default: null },
    possibleDuplicate: { type: Boolean, default: false },
    duplicateConfidence: { type: Number, default: 0 },
    duplicateReceiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Receipt',
      default: null,
    },
    duplicateReason: { type: String, default: '' },
    confidence: { type: Number, default: 0 },
    /** Shown in the app when totals do not reconcile or the worker flagged the draft. */
    reviewHint: { type: String, default: '' },
    needsReview: { type: Boolean, default: true },
    /** True when structured AI parsing failed; row still has OCR rawText. */
    aiParseFailed: { type: Boolean, default: false },
    /** Async pipeline: pending → processing → completed | failed. Omitted on legacy rows (treated as ready). */
    processingStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
    },
    /** Cloud-hosted image used for Gemini (async upload). */
    imageUrl: { type: String, default: '' },
    cloudinaryPublicId: { type: String, default: '' },
    processingError: { type: String, default: '' },
    /** Extra receipt drafts created from the same photo (multi-slip); primary row holds this list. */
    linkedReceiptIds: [{ type: mongoose.Schema.Types.ObjectId }],
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
