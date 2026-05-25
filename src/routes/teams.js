import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Branch } from '../models/Branch.js';
import { Organization } from '../models/Organization.js';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { signAuthToken, userJson } from '../lib/authSession.js';
import { invitationLinkForToken } from '../lib/frontendUrl.js';
import { sendMail } from '../utils/mailer.js';

const router = express.Router();

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

function teamMemberJson(user) {
  const branch = user.branchId && typeof user.branchId === 'object' ? user.branchId : null;
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name || '',
    role: user.role || 'MANAGER',
    status: user.status || 'PENDING',
    branchId: branch?._id?.toString?.() || user.branchId?.toString?.() || '',
    branchName: branch?.name || '',
    createdAt: user.createdAt || null,
    invitationExpiresAt: user.teamInvitationExpiresAt || null,
  };
}

function inviteLinkForToken(token) {
  return invitationLinkForToken(token);
}

function validInvitationFilter(token) {
  return {
    teamInvitationToken: token,
    status: 'PENDING',
    teamInvitationExpiresAt: { $gt: new Date() },
  };
}

async function branchManagerConflict({ organizationId, branchId, excludeUserId = null }) {
  const filter = {
    organizationId,
    branchId,
    role: 'MANAGER',
    status: { $in: ['PENDING', 'ACTIVE'] },
  };
  if (excludeUserId) {
    filter._id = { $ne: excludeUserId };
  }
  return User.findOne(filter).select('email branchId status').lean();
}

function validObjectIdOrResponse(id, res, label) {
  if (mongoose.Types.ObjectId.isValid(id)) return new mongoose.Types.ObjectId(id);
  res.status(400).json({ success: false, error: `Invalid ${label}.` });
  return null;
}

async function findManagedMember(admin, memberId) {
  return User.findOne({
    _id: memberId,
    organizationId: admin.organizationId,
    role: 'MANAGER',
  });
}

router.get('/invite/verify', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (!token) {
      return res.status(400).json({ success: false, error: 'Invitation token is required.' });
    }

    const user = await User.findOne(validInvitationFilter(token))
      .select('email name role status organizationId branchId teamInvitationExpiresAt')
      .populate('organizationId', 'name currency')
      .populate('branchId', 'name location')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'This invitation is invalid or has expired.',
      });
    }

    const organization =
      user.organizationId && typeof user.organizationId === 'object' ? user.organizationId : null;
    const branch = user.branchId && typeof user.branchId === 'object' ? user.branchId : null;

    return res.json({
      success: true,
      invitation: {
        email: user.email,
        name: user.name || '',
        role: user.role || 'MANAGER',
        status: user.status || 'PENDING',
        expiresAt: user.teamInvitationExpiresAt,
        organization: organization
          ? {
              id: organization._id.toString(),
              name: organization.name || 'Paper Brain Organization',
              currency: organization.currency || 'PKR',
            }
          : null,
        branch: branch
          ? {
              id: branch._id.toString(),
              name: branch.name || 'Assigned Branch',
              location: branch.location || '',
            }
          : null,
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: 'Could not verify invitation.' });
  }
});

router.post('/invite/accept', async (req, res) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Invitation token and password are required.',
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters.',
      });
    }

    const user = await User.findOne(validInvitationFilter(token)).select(
      '+teamInvitationToken +teamInvitationExpiresAt',
    );
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'This invitation is invalid or has expired.',
      });
    }

    user.password = await bcrypt.hash(password, 10);
    user.status = 'ACTIVE';
    user.isVerified = true;
    user.teamInvitationToken = null;
    user.teamInvitationExpiresAt = null;
    await user.save();

    const authToken = signAuthToken(user);
    return res.json({
      success: true,
      token: authToken,
      user: userJson(user),
    });
  } catch {
    return res.status(500).json({ success: false, error: 'Could not accept invitation.' });
  }
});

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const members = await User.find({
      organizationId: admin.organizationId,
      role: 'MANAGER',
    })
      .select('name email role status branchId createdAt teamInvitationExpiresAt')
      .populate('branchId', 'name location')
      .sort({ createdAt: -1, email: 1 })
      .lean();

    return res.json({
      success: true,
      members: members.map(teamMemberJson),
    });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not load team members.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.post('/invite', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const email =
      typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const branchId = typeof req.body.branchId === 'string' ? req.body.branchId.trim() : '';

    if (!email || !branchId) {
      return res.status(400).json({
        success: false,
        error: 'Email and branchId are required.',
      });
    }
    if (!mongoose.Types.ObjectId.isValid(branchId)) {
      return res.status(400).json({ success: false, error: 'Invalid branchId.' });
    }

    const branch = await Branch.findOne({
      _id: new mongoose.Types.ObjectId(branchId),
      organizationId: admin.organizationId,
    }).lean();
    if (!branch) {
      return res.status(404).json({ success: false, error: 'Branch not found.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    let user = await User.findOne({ email }).select('+teamInvitationToken +teamInvitationExpiresAt');

    if (user && user.organizationId && String(user.organizationId) !== String(admin.organizationId)) {
      return res.status(409).json({
        success: false,
        error: 'A user with this email belongs to another organization.',
      });
    }

    const assignedManager = await branchManagerConflict({
      organizationId: admin.organizationId,
      branchId: branch._id,
      excludeUserId: user?._id || null,
    });
    if (assignedManager) {
      return res.status(409).json({
        success: false,
        error: `The "${branch.name}" branch already has a manager assigned.`,
      });
    }

    if (!user) {
      const placeholderPassword = await bcrypt.hash(crypto.randomUUID(), 10);
      user = await User.create({
        name: email.split('@')[0] || 'Branch Manager',
        email,
        password: placeholderPassword,
        organizationId: admin.organizationId,
        branchId: branch._id,
        role: 'MANAGER',
        status: 'PENDING',
        isVerified: false,
        teamInvitationToken: token,
        teamInvitationExpiresAt: expiresAt,
      });
    } else {
      user.organizationId = admin.organizationId;
      user.branchId = branch._id;
      user.role = 'MANAGER';
      user.status = user.status || 'PENDING';
      user.teamInvitationToken = token;
      user.teamInvitationExpiresAt = expiresAt;
      await user.save();
    }

    const inviteUrl = inviteLinkForToken(token);
    const subject = 'You are invited to Paper Brain';
    const text = `Hi,

You have been invited to manage the "${branch.name}" branch in Paper Brain.

Accept your invitation here:
${inviteUrl}

This invitation expires in 7 days.`;
    const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b;max-width:520px">
  <h2 style="color:#7c3aed;margin:0 0 12px">Paper Brain invitation</h2>
  <p>You have been invited to manage the <strong>${branch.name}</strong> branch.</p>
  <p style="margin:28px 0">
    <a href="${inviteUrl}" style="background:#7c3aed;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Accept invitation</a>
  </p>
  <p style="font-size:13px;color:#71717a">Or copy this link:<br/><a href="${inviteUrl}">${inviteUrl}</a></p>
  <p style="font-size:13px;color:#71717a">This invitation expires in 7 days.</p>
</div>`;

    const mail = await sendMail({ to: email, subject, text, html });

    return res.status(201).json({
      success: true,
      invited: true,
      email: user.email,
      userId: user._id.toString(),
      branchId: branch._id.toString(),
      mail,
      ...(process.env.NODE_ENV !== 'production' ? { inviteUrl } : {}),
    });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not send invitation.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.patch('/:memberId', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const memberId = validObjectIdOrResponse(req.params.memberId, res, 'memberId');
    if (!memberId) return undefined;

    const branchId = typeof req.body.branchId === 'string' ? req.body.branchId.trim() : '';
    const nextBranchId = validObjectIdOrResponse(branchId, res, 'branchId');
    if (!nextBranchId) return undefined;

    const [member, branch] = await Promise.all([
      findManagedMember(admin, memberId),
      Branch.findOne({
        _id: nextBranchId,
        organizationId: admin.organizationId,
      }).lean(),
    ]);

    if (!member) {
      return res.status(404).json({ success: false, error: 'Manager not found.' });
    }
    if (!branch) {
      return res.status(404).json({ success: false, error: 'Branch not found.' });
    }

    const assignedManager = await branchManagerConflict({
      organizationId: admin.organizationId,
      branchId: branch._id,
      excludeUserId: member._id,
    });
    if (assignedManager) {
      return res.status(409).json({
        success: false,
        error: `The "${branch.name}" branch already has a manager assigned.`,
      });
    }

    member.branchId = branch._id;
    await member.save();

    const updated = await User.findById(member._id)
      .select('name email role status branchId createdAt teamInvitationExpiresAt')
      .populate('branchId', 'name location')
      .lean();

    return res.json({
      success: true,
      member: teamMemberJson(updated),
    });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not update manager.';
    return res.status(status).json({ success: false, error: message });
  }
});

router.delete('/:memberId', async (req, res) => {
  try {
    const admin = await adminWithOrganization(req.auth.userId);
    const memberId = validObjectIdOrResponse(req.params.memberId, res, 'memberId');
    if (!memberId) return undefined;

    const member = await findManagedMember(admin, memberId);
    if (!member) {
      return res.status(404).json({ success: false, error: 'Manager not found.' });
    }

    await User.deleteOne({ _id: member._id });
    return res.json({ success: true, deleted: true, memberId: member._id.toString() });
  } catch (err) {
    const status = err.status || 500;
    const message = err instanceof Error ? err.message : 'Could not delete manager.';
    return res.status(status).json({ success: false, error: message });
  }
});

export default router;
