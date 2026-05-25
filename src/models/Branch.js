import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    location: { type: String, default: '', trim: true },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
  },
);

export const Branch =
  mongoose.models.Branch || mongoose.model('Branch', branchSchema);
