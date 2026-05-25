import express from 'express';
import mongoose from 'mongoose';
import { Expense } from '../models/Expense.js';
import { Receipt } from '../models/Receipt.js';
import { User } from '../models/User.js';
import {
  applyReceiptValidation,
  hasReceiptLineAmount,
  validateTotals,
} from '../lib/receiptValidation.js';
import {
  isReceiptCategory,
  normalizeReceiptCategory,
} from '../lib/receiptCategories.js';
import {
  dataAccessFilter,
  objectIdOrNull,
  resolveUserAccessScope,
  scopedDocumentFilter,
} from '../lib/accessScope.js';
import { processTimingMiddleware } from '../middleware/processTiming.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();
router.use(processTimingMiddleware);
router.use(requireAuth);

async function expenseFilterForUser(req, query) {
  const scope = await resolveUserAccessScope(req.auth.userId, query?.branchId);
  await repairMissingExpensesFromParsedReceipts(scope);
  await backfillExpenseScopesFromReceipts(scope);
  const base = buildExpenseFilter(query);
  const filter = {
    ...base,
    ...dataAccessFilter(scope),
  };
  await applyOrgPeopleFilters(filter, scope, query);
  return filter;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function applyOrgPeopleFilters(filter, scope, query) {
  if (scope.isAdmin) {
    const branchId = objectIdOrNull(query?.branchId);
    if (branchId) filter.branchId = branchId;
  }

  const uploadedBy = objectIdOrNull(query?.uploadedBy);
  if (uploadedBy) {
    filter.uploadedBy = uploadedBy;
    return;
  }

  const manager =
    typeof query?.manager === 'string' ? query.manager.trim() : '';
  if (!manager) return;

  const users = await User.find({
    organizationId: scope.organizationId,
    role: 'MANAGER',
    $or: [
      { name: new RegExp(escapeRegex(manager), 'i') },
      { email: new RegExp(escapeRegex(manager), 'i') },
    ],
  })
    .select('_id')
    .lean();
  filter.uploadedBy = { $in: users.map((u) => u._id) };
}

function branchJson(branch) {
  if (!branch || typeof branch !== 'object') return null;
  return {
    id: branch._id?.toString?.() || '',
    name: branch.name || '',
    location: branch.location || '',
  };
}

function uploaderJson(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user._id?.toString?.() || '',
    name: user.name || '',
    email: user.email || '',
    role: user.role || '',
  };
}

function enrichExpenseRow(row) {
  return {
    ...row,
    branch: branchJson(row.branchId),
    uploadedByUser: uploaderJson(row.uploadedBy),
  };
}

function finalDataFromReceipt(receipt) {
  return {
    vendor: receipt.vendor || '',
    total: receipt.total ?? null,
    currency: receipt.currency || 'USD',
    date: receipt.date || null,
    tax: receipt.tax ?? null,
    items: Array.isArray(receipt.items) ? receipt.items : [],
    category: receipt.category,
    categorySource: receipt.categorySource,
    categoryConfidence: receipt.categoryConfidence ?? null,
  };
}

async function repairMissingExpensesFromParsedReceipts(scope) {
  const receipts = await Receipt.find({
    ...dataAccessFilter(scope),
    expense: null,
    aiParseFailed: { $ne: true },
    processingStatus: { $nin: ['pending', 'processing', 'failed'] },
    $or: [{ vendor: { $ne: null } }, { total: { $ne: null } }],
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  for (const receipt of receipts) {
    if (!receipt.organizationId || !receipt.branchId) continue;
    const finalData = finalDataFromReceipt(receipt);
    const confidence =
      typeof receipt.confidence === 'number' && !Number.isNaN(receipt.confidence)
        ? receipt.confidence
        : 0;
    const expense = await Expense.create({
      user: receipt.user,
      organizationId: receipt.organizationId,
      branchId: receipt.branchId,
      uploadedBy: receipt.uploadedBy || receipt.user,
      rawText: typeof receipt.rawText === 'string' ? receipt.rawText : '',
      originalAiData: finalData,
      finalData,
      confidence,
      confidenceFlag: confidence >= 80 && !receipt.needsReview ? 'auto' : 'review',
      isCorrected: false,
      status: 'approved',
    });
    await Receipt.updateOne(
      {
        _id: receipt._id,
        expense: null,
      },
      { $set: { expense: expense._id } },
    );
  }
}

async function backfillExpenseScopesFromReceipts(scope) {
  const receipts = await Receipt.find({
    ...dataAccessFilter(scope),
    expense: { $ne: null },
  })
    .select('expense organizationId branchId uploadedBy user')
    .lean();

  const writes = [];
  for (const receipt of receipts) {
    if (!receipt.expense || !receipt.organizationId || !receipt.branchId) continue;
    writes.push({
      updateOne: {
        filter: {
          _id: receipt.expense,
          $or: [
            { organizationId: { $exists: false } },
            { organizationId: null },
            { branchId: { $exists: false } },
            { branchId: null },
            { uploadedBy: { $exists: false } },
            { uploadedBy: null },
          ],
        },
        update: {
          $set: {
            organizationId: receipt.organizationId,
            branchId: receipt.branchId,
            uploadedBy: receipt.uploadedBy || receipt.user,
          },
        },
      },
    });
  }

  if (writes.length > 0) {
    await Expense.bulkWrite(writes, { ordered: false });
  }
}

function cloneJson(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/** Query: `from`, `to` (YYYY-MM-DD on `createdAt`), `vendor`, `confidenceFlag`, `category`. */
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
  const category = typeof query.category === 'string' ? query.category.trim() : '';
  if (isReceiptCategory(category)) {
    filter['finalData.category'] = category;
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

async function spendingSummary(filter) {
  const [currencyRows, categoryRows] = await Promise.all([
    Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$finalData.currency',
          total: { $sum: { $ifNull: ['$finalData.total', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$finalData.category',
          total: { $sum: { $ifNull: ['$finalData.total', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]),
  ]);
  const byCurrency = {};
  const byCategory = {};
  let expenseCount = 0;
  for (const r of currencyRows) {
    const key =
      r._id !== undefined && r._id !== null && String(r._id).trim() !== ''
        ? String(r._id)
        : 'UNKNOWN';
    byCurrency[key] = { total: r.total, count: r.count };
    expenseCount += r.count;
  }
  for (const r of categoryRows) {
    const key = normalizeReceiptCategory(r._id);
    byCategory[key] = {
      total: (byCategory[key]?.total || 0) + r.total,
      count: (byCategory[key]?.count || 0) + r.count,
    };
  }
  return { expenseCount, byCurrency, byCategory };
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
    'category',
    'branch',
    'uploadedByName',
    'uploadedByEmail',
    'tax',
    'confidence',
    'confidenceFlag',
    'status',
    'rawText',
  ];
  const lines = [headers.join(',')];
  for (const ex of rows) {
    const fd = ex.finalData && typeof ex.finalData === 'object' ? ex.finalData : {};
    const branch = ex.branchId && typeof ex.branchId === 'object' ? ex.branchId : null;
    const uploadedBy = ex.uploadedBy && typeof ex.uploadedBy === 'object' ? ex.uploadedBy : null;
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
        csvEscape(fd.category),
        csvEscape(branch?.name || ''),
        csvEscape(uploadedBy?.name || ''),
        csvEscape(uploadedBy?.email || ''),
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
    const filter = await expenseFilterForUser(req, req.query);
    const rows = await Expense.find(filter)
      .sort({ createdAt: -1 })
      .limit(2000)
      .populate('branchId', 'name location')
      .populate('uploadedBy', 'name email role')
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
    const filter = await expenseFilterForUser(req, req.query);
    const { limit, skip } = parseLimitSkip(req.query);
    const [expenses, totalCount, summary] = await Promise.all([
      Expense.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('branchId', 'name location')
        .populate('uploadedBy', 'name email role')
        .lean(),
      Expense.countDocuments(filter),
      spendingSummary(filter),
    ]);
    return res.json({
      success: true,
      expenses: expenses.map(enrichExpenseRow),
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
  normalized.category = normalizeReceiptCategory(normalized.category);
  normalized.categorySource =
    normalized.categorySource === 'MANUAL' || normalized.categorySource === 'RULE'
      ? normalized.categorySource
      : 'AI';

  const priced = normalized.items?.some(hasReceiptLineAmount);
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
    const scope = await resolveUserAccessScope(req.auth.userId, req.body?.branchId);
    let pendingReceipt = null;
    let expenseScope = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      uploadedBy: scope.userId,
    };
    if (v.receiptObjectId) {
      pendingReceipt = await Receipt.findOne({
        _id: v.receiptObjectId,
        expense: null,
        ...dataAccessFilter(scope),
      })
        .select('_id category categorySource organizationId branchId uploadedBy')
        .lean();
      if (!pendingReceipt) {
        return res.status(400).json({
          success: false,
          error: 'Receipt draft not found or already linked.',
        });
      }
      if (!req.body?.finalData?.category && pendingReceipt.category) {
        v.normalized.category = normalizeReceiptCategory(pendingReceipt.category);
        v.normalized.categorySource = pendingReceipt.categorySource || 'AI';
      }
      expenseScope = {
        organizationId: pendingReceipt.organizationId || scope.organizationId,
        branchId: pendingReceipt.branchId || scope.branchId,
        uploadedBy: pendingReceipt.uploadedBy || scope.userId,
      };
    }

    const expense = await Expense.create({
      user: req.auth.userId,
      organizationId: expenseScope.organizationId,
      branchId: expenseScope.branchId,
      uploadedBy: expenseScope.uploadedBy,
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
        scopedDocumentFilter(scope, { _id: v.receiptObjectId }),
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
    const scope = await resolveUserAccessScope(req.auth.userId);
    const expense = await Expense.findOneAndUpdate(
      scopedDocumentFilter(scope, { _id: id }),
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
      { returnDocument: 'after', runValidators: true },
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
    const scope = await resolveUserAccessScope(req.auth.userId);
    const deleted = await Expense.findOneAndDelete({
      _id: id,
      ...dataAccessFilter(scope),
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
