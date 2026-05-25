import mongoose from 'mongoose';
import { Branch } from '../models/Branch.js';
import { Organization } from '../models/Organization.js';
import { User } from '../models/User.js';

export function objectIdOrNull(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

async function defaultBranchForOrganization(organizationId) {
  const orgId = objectIdOrNull(organizationId);
  if (!orgId) return null;

  const existing = await Branch.findOne({ organizationId: orgId }).sort({ createdAt: 1 });
  if (existing?._id) return existing._id;

  const branch = await Branch.create({
    organizationId: orgId,
    name: 'Main Branch',
    location: '',
  });
  return branch._id;
}

export async function resolveUserAccessScope(userId, requestedBranchId = '') {
  const uid = objectIdOrNull(userId);
  if (!uid) {
    const err = new Error('Invalid user.');
    err.status = 401;
    throw err;
  }

  const user = await User.findById(uid).select('name organizationId branchId role');
  if (!user) {
    const err = new Error('User not found.');
    err.status = 401;
    throw err;
  }

  let organizationId = objectIdOrNull(user.organizationId);
  if (!organizationId) {
    const organization = await Organization.create({
      name: user.name ? `${user.name}'s Organization` : 'Paper Brain Organization',
      ownerId: uid,
      currency: 'PKR',
    });
    organizationId = organization._id;
  }

  const role = user.role === 'MANAGER' ? 'MANAGER' : 'ADMIN';
  let branchId = null;

  if (role === 'MANAGER') {
    branchId = objectIdOrNull(user.branchId);
  } else {
    const requested = objectIdOrNull(requestedBranchId);
    if (requested) {
      const branch = await Branch.findOne({
        _id: requested,
        organizationId,
      }).select('_id');
      branchId = branch?._id || null;
    }
    if (!branchId) {
      branchId = await defaultBranchForOrganization(organizationId);
    }
  }

  const update = {};
  if (!user.organizationId || String(user.organizationId) !== String(organizationId)) {
    update.organizationId = organizationId;
  }
  if (role === 'MANAGER' && branchId && String(user.branchId || '') !== String(branchId)) {
    update.branchId = branchId;
  }
  if (Object.keys(update).length > 0) {
    await User.updateOne({ _id: uid }, { $set: update });
  }

  return {
    userId: uid,
    organizationId,
    branchId,
    role,
    isAdmin: role === 'ADMIN',
  };
}

export function dataAccessFilter(scope) {
  const filter = {
    organizationId: scope.organizationId,
  };
  if (!scope.isAdmin) {
    filter.branchId = scope.branchId;
  }
  return filter;
}

export function scopedDocumentFilter(scope, extra = {}) {
  return {
    ...extra,
    ...dataAccessFilter(scope),
  };
}
