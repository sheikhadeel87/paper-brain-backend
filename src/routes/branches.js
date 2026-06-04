import express from 'express';
import mongoose from 'mongoose';
import { Branch } from '../models/Branch.js';
import { Expense } from '../models/Expense.js';
import { Organization } from '../models/Organization.js';
import { Receipt } from '../models/Receipt.js';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

router.use(requireAuth);

async function adminWithOrganization(userId) {
  const user = await User.findById(userId).select('name role organizationId');
  if (!user) {
    const err = new Error('User not found.');
    err.status = 401;
    throw err;
  }
  if (user.role !== 'ADMIN') {
    const err = new Error('Admin access required.');
    err.status = 403;
    throw err;
  }
  if (user.organizationId) return user;

  const organization = await Organization.create({
    name: user.name ? `${user.name}'s Organization` : 'Paper Brain Organization',
    ownerId: user._id,
    currency: 'PKR',
  });
  user.organizationId = organization._id;
  await user.save();
  return user;
}

function branchJson(branch) {
  return {
    id: branch._id.toString(),
    organizationId: branch.organizationId?.toString() || '',
    name: branch.name,
    location: branch.location || '',
    createdAt: branch.createdAt,
  };
}

function validObjectIdOrResponse(id, res, label) {
  if (mongoose.Types.ObjectId.isValid(id)) return new mongoose.Types.ObjectId(id);
  res.status(400).json({ success: false, error: `Invalid ${label}.` });
  return null;
}

router.post('/', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const location =
      typeof req.body.location === 'string' ? req.body.location.trim() : '';

    if (!name) {
      return res.status(400).json({ success: false, error: 'Branch name is required.' });
    }

    const branch = await Branch.create({
      organizationId: admin.organizationId,
      name,
      location,
    });

    return res.status(201).json({ success: true, branch: branchJson(branch) });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not create branch.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.get('/', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const branches = await Branch.find({ organizationId: admin.organizationId })
      .sort({ createdAt: 1, name: 1 })
      .lean();

    return res.json({
      success: true,
      branches: branches.map(branchJson),
    });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not load branches.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.patch('/:branchId', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const branchId = validObjectIdOrResponse(req.params.branchId, res, 'branchId');
    if (!branchId) return undefined;

    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const location =
      typeof req.body.location === 'string' ? req.body.location.trim() : '';

    if (!name) {
      return res.status(400).json({ success: false, error: 'Branch name is required.' });
    }

    const branch = await Branch.findOneAndUpdate(
      { _id: branchId, organizationId: admin.organizationId },
      { $set: { name, location } },
      { returnDocument: 'after', runValidators: true },
    ).lean();

    if (!branch) {
      return res.status(404).json({ success: false, error: 'Branch not found.' });
    }

    return res.json({ success: true, branch: branchJson(branch) });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not update branch.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.delete('/:branchId', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const branchId = validObjectIdOrResponse(req.params.branchId, res, 'branchId');
    if (!branchId) return undefined;

    const branch = await Branch.findOne({
      _id: branchId,
      organizationId: admin.organizationId,
    }).lean();
    if (!branch) {
      return res.status(404).json({ success: false, error: 'Branch not found.' });
    }

    const [managerCount, expenseCount, receiptCount] = await Promise.all([
      User.countDocuments({
        organizationId: admin.organizationId,
        branchId,
        role: 'MANAGER',
        status: { $in: ['PENDING', 'ACTIVE'] },
      }),
      Expense.countDocuments({ organizationId: admin.organizationId, branchId }),
      Receipt.countDocuments({ organizationId: admin.organizationId, branchId }),
    ]);

    if (managerCount > 0 || expenseCount > 0 || receiptCount > 0) {
      return res.status(409).json({
        success: false,
        error:
          'This branch has managers or receipt history. Reassign/remove managers and keep history before deleting.',
      });
    }

    await Branch.deleteOne({ _id: branchId, organizationId: admin.organizationId });
    return res.json({ success: true, deleted: true, branchId: branch._id.toString() });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not delete branch.';
    return res.status(status).json({ success: false, error: message });
  }
});

export default router;
