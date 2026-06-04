import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    imageUrl: { type: String, default: '' },
    cloudinaryPublicId: { type: String, default: '' },
    rawText: { type: String, default: '' },
    /** Full Gemini JSON as returned (or `{ aiParseFailed: true }` when user saved after AI failure). */
    originalAiData: { type: mongoose.Schema.Types.Mixed, required: true },
    /** User-confirmed values after review. */
    finalData: { type: mongoose.Schema.Types.Mixed, required: true },
    /** Snapshot from validated `finalData` at save time (MVP §11). */
    confidence: { type: Number, default: 0 },
    confidenceFlag: {
      type: String,
      enum: ['auto', 'review'],
      default: 'review',
    },
    isCorrected: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['draft', 'approved'],
      default: 'approved',
    },
  },
  { timestamps: true },
);

export const Expense =
  mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
