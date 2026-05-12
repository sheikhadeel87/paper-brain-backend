import mongoose from 'mongoose';

/**
 * Inngest async upload staging row — **not** a receipt draft. Real `Receipt` documents are
 * created only when processing finishes so “Recent receipts” `createdAt` reflects true order
 * under per-user Inngest concurrency.
 */
const receiptUploadJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    imageUrl: { type: String, default: '' },
    cloudinaryPublicId: { type: String, default: '' },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    resultReceiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Receipt',
      default: null,
    },
    processingError: { type: String, default: '' },
  },
  { timestamps: true },
);

export const ReceiptUploadJob =
  mongoose.models.ReceiptUploadJob ||
  mongoose.model('ReceiptUploadJob', receiptUploadJobSchema);
