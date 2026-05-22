import mongoose from 'mongoose';
import { Receipt } from '../models/Receipt.js';

const DEFAULT_RESULT = {
  possibleDuplicate: false,
  confidenceScore: 0,
  matchedReceipt: null,
  duplicateReason: '',
};

function normText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  const s = normText(value);
  if (!s) return [];
  return [...new Set(s.split(' ').filter((t) => t.length > 1))];
}

function tokenSimilarity(a, b) {
  const aa = tokens(a);
  const bb = tokens(b);
  if (aa.length === 0 || bb.length === 0) return 0;
  const bSet = new Set(bb);
  const inter = aa.filter((t) => bSet.has(t)).length;
  const union = new Set([...aa, ...bb]).size;
  return union > 0 ? inter / union : 0;
}

function vendorSimilarity(a, b) {
  const aa = normText(a);
  const bb = normText(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.9;
  return tokenSimilarity(aa, bb);
}

function totalSimilarity(a, b) {
  const aa = Number(a);
  const bb = Number(b);
  if (!Number.isFinite(aa) || !Number.isFinite(bb) || aa <= 0 || bb <= 0) {
    return 0;
  }
  const diff = Math.abs(aa - bb);
  if (diff <= 0.5) return 1;
  const pct = diff / Math.max(aa, bb);
  if (pct <= 0.01) return 0.85;
  if (pct <= 0.03) return 0.55;
  return 0;
}

function receiptDay(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function timeSignal(createdAt, receiptDate, matchedDate) {
  const t = createdAt ? new Date(createdAt).getTime() : 0;
  if (!Number.isFinite(t) || t <= 0) {
    return { score: 0, crossDay: receiptDay(receiptDate) !== receiptDay(matchedDate) };
  }
  const minutes = Math.abs(Date.now() - t) / 60000;
  const uploadSameDay = new Date(t).toDateString() === new Date().toDateString();
  const receiptSameDay = receiptDay(receiptDate) && receiptDay(receiptDate) === receiptDay(matchedDate);
  const crossDay = receiptDay(receiptDate) && receiptDay(matchedDate) && !receiptSameDay;

  if (minutes <= 10) return { score: 1, crossDay };
  if (minutes <= 120) return { score: 0.65, crossDay };
  if (uploadSameDay && minutes <= 1440) return { score: 0.25, crossDay };
  return { score: 0, crossDay };
}

function itemText(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => `${item?.name || ''} ${item?.price ?? ''}`)
    .join(' ');
}

function duplicateReason(score, matched) {
  const pct = Math.round(score);
  const vendor = matched?.vendor || 'same vendor';
  const total = matched?.total != null ? `same total (${matched.total})` : 'similar total';
  return `Possible duplicate: ${vendor}, ${total}, ${pct}% match.`;
}

function publicMatchedReceipt(row) {
  if (!row) return null;
  return {
    id: String(row._id),
    vendor: row.vendor || '',
    total: row.total ?? null,
    currency: row.currency || '',
    date: row.date || null,
    createdAt: row.createdAt || null,
  };
}

export async function detectDuplicateReceipt(userId, receiptData) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return DEFAULT_RESULT;
  }
  const vendor = receiptData?.vendor || '';
  const total = receiptData?.total;
  if (!vendor || total === null || total === undefined || Number.isNaN(Number(total))) {
    return DEFAULT_RESULT;
  }

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await Receipt.find({
    user: new mongoose.Types.ObjectId(String(userId)),
    createdAt: { $gte: since },
    processingStatus: { $nin: ['pending', 'processing', 'failed'] },
  })
    .sort({ createdAt: -1 })
    .limit(60)
    .lean();

  let best = null;
  for (const row of rows) {
    const vendorScore = vendorSimilarity(vendor, row.vendor);
    const totalScore = totalSimilarity(total, row.total);
    if (vendorScore < 0.45 || totalScore < 0.55) continue;

    const rawScore = Math.max(
      tokenSimilarity(receiptData?.rawText, row.rawText),
      tokenSimilarity(itemText(receiptData?.items), itemText(row.items)),
    );
    const { score: timeScore, crossDay } = timeSignal(
      row.createdAt,
      receiptData?.date,
      row.date,
    );
    let score =
      vendorScore * 25 +
      totalScore * 25 +
      timeScore * 30 +
      rawScore * 20;

    if (crossDay) {
      score -= 35;
      if (rawScore < 0.9) score = Math.min(score, 49);
      else score = Math.min(score, 65);
    } else if (timeScore < 0.65 && rawScore < 0.75) {
      score = Math.min(score, 69);
    }

    if (!best || score > best.score) {
      best = { row, score };
    }
  }

  if (!best || best.score < 75) return DEFAULT_RESULT;

  const score = Math.round(best.score);
  return {
    possibleDuplicate: true,
    confidenceScore: score,
    matchedReceipt: publicMatchedReceipt(best.row),
    duplicateReason: duplicateReason(score, best.row),
  };
}
