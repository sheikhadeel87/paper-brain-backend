import mongoose from 'mongoose';
import { ReceiptUploadCounter } from '../models/ReceiptUploadCounter.js';

export const FREE_TIER_DAILY_RECEIPT_UPLOADS = 5;

export const FREE_TIER_LIMIT_MESSAGE =
  "You've reached today's limit of 5 receipt scans on the Free plan. Upgrade to Pro for unlimited uploads and the full Paper Brain experience.";

export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isProPlan(plan) {
  return String(plan || '').toLowerCase() === 'pro';
}

export async function getReceiptUploadUsage(userId, plan) {
  const limit = FREE_TIER_DAILY_RECEIPT_UPLOADS;
  if (isProPlan(plan)) {
    return {
      plan: 'pro',
      limit: null,
      used: 0,
      remaining: null,
      resetsAt: startOfUtcDay(new Date(Date.now() + 86_400_000)).toISOString(),
    };
  }

  const day = utcDayKey();
  const uid = new mongoose.Types.ObjectId(userId);
  const doc = await ReceiptUploadCounter.findOne({ user: uid, day }).lean();
  const used = doc?.count ?? 0;
  return {
    plan: 'free',
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: startOfUtcDay(new Date(Date.now() + 86_400_000)).toISOString(),
  };
}

/**
 * Reserve upload slots for Free users (atomic). Pro users always pass.
 * @returns {{ ok: true, used: number, limit: number, remaining: number } | { ok: false, used: number, limit: number, remaining: number }}
 */
export async function reserveReceiptUploadSlots(userId, plan, slots = 1) {
  const limit = FREE_TIER_DAILY_RECEIPT_UPLOADS;
  const slotsN = Math.max(1, Math.floor(Number(slots) || 1));

  if (isProPlan(plan)) {
    return { ok: true, used: 0, limit, remaining: null };
  }

  const day = utcDayKey();
  const uid = new mongoose.Types.ObjectId(userId);

  const updated = await ReceiptUploadCounter.findOneAndUpdate(
    { user: uid, day, count: { $lte: limit - slotsN } },
    { $inc: { count: slotsN } },
    { new: true },
  );

  if (updated) {
    return {
      ok: true,
      used: updated.count,
      limit,
      remaining: Math.max(0, limit - updated.count),
    };
  }

  const existing = await ReceiptUploadCounter.findOne({ user: uid, day }).lean();
  const used = existing?.count ?? 0;

  if (used + slotsN <= limit) {
    try {
      const created = await ReceiptUploadCounter.create({
        user: uid,
        day,
        count: slotsN,
      });
      return {
        ok: true,
        used: created.count,
        limit,
        remaining: Math.max(0, limit - created.count),
      };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const retry = await ReceiptUploadCounter.findOneAndUpdate(
        { user: uid, day, count: { $lte: limit - slotsN } },
        { $inc: { count: slotsN } },
        { new: true },
      );
      if (retry) {
        return {
          ok: true,
          used: retry.count,
          limit,
          remaining: Math.max(0, limit - retry.count),
        };
      }
    }
  }

  const fresh = await ReceiptUploadCounter.findOne({ user: uid, day }).lean();
  const usedNow = fresh?.count ?? used;
  return {
    ok: false,
    used: usedNow,
    limit,
    remaining: Math.max(0, limit - usedNow),
  };
}

export function freeTierLimitJson({ used, limit, remaining }) {
  return {
    success: false,
    code: 'FREE_TIER_DAILY_LIMIT',
    error: FREE_TIER_LIMIT_MESSAGE,
    used,
    limit,
    remaining: remaining ?? Math.max(0, limit - used),
    upgradeRequired: true,
  };
}
