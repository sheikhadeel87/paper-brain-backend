import express from 'express';
import mongoose from 'mongoose';
import { Expense } from '../models/Expense.js';
import { Receipt } from '../models/Receipt.js';
import {
  applyReceiptValidation,
  validateTotals,
} from '../lib/receiptValidation.js';
import { processTimingMiddleware } from '../middleware/processTiming.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();
router.use(processTimingMiddleware);
router.use(requireAuth);

function expenseFilterForUser(req, query) {
  const base = buildExpenseFilter(query);
  return {
    ...base,
    user: new mongoose.Types.ObjectId(req.auth.userId),
  };
}

function cloneJson(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Query: `from`, `to` (YYYY-MM-DD on `createdAt`), `vendor` (substring on `finalData.vendor`), `confidenceFlag` (`auto` | `review`). */
function buildExpenseFilter(query) {
  const filter = {};
  const from = typeof query.from === 'string' ? query.from.trim() : '';
  const to = typeof query.to === 'string' ? query.to.trim() : '';
  const dateRange = {};
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    dateRange.$gte = new Date(`${from}T00:00:00.000Z`);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    dateRange.$lte = new Date(`${to}T23:59:59.999Z`);
  }
  if (Object.keys(dateRange).length > 0) {
    filter.createdAt = dateRange;
  }
  const vendor = typeof query.vendor === 'string' ? query.vendor.trim() : '';
  if (vendor.length > 0) {
    filter['finalData.vendor'] = new RegExp(escapeRegex(vendor), 'i');
  }
  const cf =
    typeof query.confidenceFlag === 'string' ? query.confidenceFlag.trim().toLowerCase() : '';
  if (cf === 'auto' || cf === 'review') {
    filter.confidenceFlag = cf;
  }
  return filter;
}

function parseLimitSkip(query) {
  const lim = parseInt(String(query.limit ?? ''), 10);
  const sk = parseInt(String(query.skip ?? ''), 10);
  const limit = Number.isFinite(lim) ? Math.min(Math.max(lim, 1), 500) : 100;
  const skip = Number.isFinite(sk) ? Math.max(sk, 0) : 0;
  return { limit, skip };
}

async function spendingSummaryByCurrency(filter) {
  const rows = await Expense.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$finalData.currency',
        total: { $sum: { $ifNull: ['$finalData.total', 0] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const byCurrency = {};
  let expenseCount = 0;
  for (const r of rows) {
    const key =
      r._id !== undefined && r._id !== null && String(r._id).trim() !== ''
        ? String(r._id)
        : 'UNKNOWN';
    byCurrency[key] = { total: r.total, count: r.count };
    expenseCount += r.count;
  }
  return { expenseCount, byCurrency };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function expensesToCsv(rows) {
  const headers = [
    'id',
    'createdAt',
    'vendor',
    'date',
    'total',
    'currency',
    'tax',
    'confidence',
    'confidenceFlag',
    'status',
    'rawText',
  ];
  const lines = [headers.join(',')];
  for (const ex of rows) {
    const fd = ex.finalData && typeof ex.finalData === 'object' ? ex.finalData : {};
    const rt = typeof ex.rawText === 'string' ? ex.rawText : '';
    const rtShort = rt.length > 2000 ? `${rt.slice(0, 2000)}…` : rt;
    const created =
      ex.createdAt instanceof Date
        ? ex.createdAt.toISOString()
        : ex.createdAt
          ? String(ex.createdAt)
          : '';
    lines.push(
      [
        csvEscape(ex._id?.toString()),
        csvEscape(created),
        csvEscape(fd.vendor),
        csvEscape(fd.date),
        csvEscape(fd.total),
        csvEscape(fd.currency),
        csvEscape(fd.tax),
        csvEscape(ex.confidence ?? fd.confidence),
        csvEscape(ex.confidenceFlag ?? fd.confidence_flag),
        csvEscape(ex.status),
        csvEscape(rtShort),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

router.get('/export', async (req, res) => {
  try {
    const filter = expenseFilterForUser(req, req.query);
    const rows = await Expense.find(filter)
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean();
    const csv = expensesToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    res.status(500).json({ success: false, error: message });
  }
});

router.get('/', async (req, res) => {
  try {
    const filter = expenseFilterForUser(req, req.query);
    const { limit, skip } = parseLimitSkip(req.query);
    const [expenses, totalCount, summary] = await Promise.all([
      Expense.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Expense.countDocuments(filter),
      spendingSummaryByCurrency(filter),
    ]);
    return res.json({
      success: true,
      expenses,
      totalCount,
      summary,
      limit,
      skip,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'List failed';
    return res.status(500).json({ success: false, error: message });
  }
});

/** After validation: review if flag is review or confidence is below 80 (MVP §9). */
function resolvedReviewGate(normalized) {
  const c =
    typeof normalized.confidence === 'number' && !Number.isNaN(normalized.confidence)
      ? normalized.confidence
      : 0;
  const mustReview =
    normalized.confidence_flag === 'review' || c < 80;
  normalized.confidence_flag = mustReview ? 'review' : 'auto';
  return { mustReview, confidence: c };
}

/**
 * Shared create/update validation for `POST /` and `PATCH /:id`.
 * @returns {{ ok: true, value: object } | { ok: false, status: number, json: object }}
 */
function prepareExpenseBody(body) {
  const {
    rawText,
    originalAiData,
    finalData,
    isCorrected,
    status,
    confirmReview,
    receiptId,
  } = body;

  if (finalData === null || typeof finalData !== 'object' || Array.isArray(finalData)) {
    return {
      ok: false,
      status: 400,
      json: { success: false, error: 'finalData (object) is required.' },
    };
  }

  let original =
    originalAiData === null || originalAiData === undefined
      ? {}
      : originalAiData;
  if (typeof original !== 'object' || Array.isArray(original)) {
    return {
      ok: false,
      status: 400,
      json: {
        success: false,
        error: 'originalAiData must be an object (use {} if AI did not return data).',
      },
    };
  }

  original = cloneJson(original);

  let normalized;
  try {
    normalized = cloneJson(finalData);
  } catch {
    return {
      ok: false,
      status: 400,
      json: { success: false, error: 'finalData could not be parsed.' },
    };
  }

  applyReceiptValidation(normalized);

  const priced = normalized.items?.some(
    (item) =>
      item &&
      typeof item.price === 'number' &&
      !Number.isNaN(item.price),
  );
  const totalsCheck = validateTotals(
    normalized.items || [],
    normalized.total,
    normalized.tax,
  );

  if (priced && !totalsCheck.isValid) {
    return {
      ok: false,
      status: 422,
      json: {
        success: false,
        error: 'Total does not match sum of line item prices.',
        validation: totalsCheck,
        normalizedFinalData: normalized,
      },
    };
  }

  if (confirmReview === true && original.aiParseFailed === true) {
    const c0 =
      typeof normalized.confidence === 'number' && !Number.isNaN(normalized.confidence)
        ? normalized.confidence
        : 0;
    normalized.confidence = Math.max(c0, 70);
  }

  const { mustReview } = resolvedReviewGate(normalized);
  const wantsApproved = status !== 'draft';
  if (wantsApproved && mustReview && confirmReview !== true) {
    return {
      ok: false,
      status: 422,
      json: {
        success: false,
        code: 'REVIEW_CONFIRMATION_REQUIRED',
        error:
          'This expense is flagged for review (low confidence or validation). Confirm below, or save as draft (status: "draft").',
      },
    };
  }

  let receiptObjectId = null;
  if (receiptId !== undefined && receiptId !== null && String(receiptId).trim() !== '') {
    const rid = String(receiptId).trim();
    if (!mongoose.Types.ObjectId.isValid(rid)) {
      return {
        ok: false,
        status: 400,
        json: { success: false, error: 'Invalid receiptId.' },
      };
    }
    receiptObjectId = new mongoose.Types.ObjectId(rid);
  }

  const confidence =
    typeof normalized.confidence === 'number' && !Number.isNaN(normalized.confidence)
      ? normalized.confidence
      : 0;
  const confidenceFlag =
    normalized.confidence_flag === 'auto' ? 'auto' : 'review';

  return {
    ok: true,
    value: {
      normalized,
      original,
      rawText: typeof rawText === 'string' ? rawText : '',
      confidence,
      confidenceFlag,
      isCorrected: Boolean(isCorrected),
      status: status === 'draft' ? 'draft' : 'approved',
      receiptObjectId,
    },
  };
}

router.post('/', async (req, res) => {
  const prep = prepareExpenseBody(req.body);
  if (!prep.ok) {
    return res.status(prep.status).json(prep.json);
  }
  const v = prep.value;

  try {
    if (v.receiptObjectId) {
      const pending = await Receipt.findOne({
        _id: v.receiptObjectId,
        user: req.auth.userId,
        expense: null,
      })
        .select('_id')
        .lean();
      if (!pending) {
        return res.status(400).json({
          success: false,
          error: 'Receipt draft not found or already linked.',
        });
      }
    }

    const expense = await Expense.create({
      user: req.auth.userId,
      rawText: v.rawText,
      originalAiData: v.original,
      finalData: v.normalized,
      confidence: v.confidence,
      confidenceFlag: v.confidenceFlag,
      isCorrected: v.isCorrected,
      status: v.status,
    });

    if (v.receiptObjectId) {
      await Receipt.updateOne(
        { _id: v.receiptObjectId, user: req.auth.userId },
        { $set: { expense: expense._id } },
      );
    }

    return res.status(201).json({
      success: true,
      id: expense._id,
      expense,
      needsReview: v.confidenceFlag === 'review',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Save failed';
    return res.status(500).json({ success: false, error: message });
  }
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: 'Invalid expense id.' });
  }

  const prep = prepareExpenseBody(req.body);
  if (!prep.ok) {
    return res.status(prep.status).json(prep.json);
  }
  const v = prep.value;

  try {
    const expense = await Expense.findOneAndUpdate(
      { _id: id, user: req.auth.userId },
      {
        $set: {
          rawText: v.rawText,
          originalAiData: v.original,
          finalData: v.normalized,
          confidence: v.confidence,
          confidenceFlag: v.confidenceFlag,
          isCorrected: v.isCorrected,
          status: v.status,
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (!expense) {
      return res.status(404).json({ success: false, error: 'Expense not found.' });
    }

    return res.json({
      success: true,
      expense,
      needsReview: v.confidenceFlag === 'review',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed';
    return res.status(500).json({ success: false, error: message });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: 'Invalid expense id.' });
  }

  try {
    const deleted = await Expense.findOneAndDelete({
      _id: id,
      user: req.auth.userId,
    }).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Expense not found.' });
    }
    return res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;
