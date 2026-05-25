import mongoose from 'mongoose';

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    currency: { type: String, default: 'PKR', trim: true },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
  },
);

export const Organization =
  mongoose.models.Organization ||
  mongoose.model('Organization', organizationSchema);
