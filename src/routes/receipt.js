import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { applyReceiptValidation, validateTotals } from '../lib/receiptValidation.js';
import { uploadReceiptImageBuffer } from '../services/cloudinaryUpload.js';
import { inngest } from '../inngest/client.js';
import {
  advanceGeminiKeyIndexAfterQuota,
  advanceGeminiKeyIndexAfterSuccess,
  getGeminiApiKeys,
  isGeminiQuotaLikeError,
  peekGeminiKeyIndex,
} from '../lib/geminiApiKeyPool.js';
import { Receipt } from '../models/Receipt.js';
import { processTimingMiddleware } from '../middleware/processTiming.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { receiptQueue } from '../services/queue/receiptQueue.js'

const router = express.Router();
router.use(processTimingMiddleware);
router.use(requireAuth);

/** Cloudinary + Inngest event key: enables 202 async receipt processing (inline so Vercel NFT always ships this file with receipt.js). */
function receiptAsyncPipelineEnabled() {
  const cloud =
    Boolean(String(process.env.CLOUDINARY_URL || '').trim()) ||
    (Boolean(String(process.env.CLOUDINARY_CLOUD_NAME || '').trim()) &&
      Boolean(String(process.env.CLOUDINARY_API_KEY || '').trim()) &&
      Boolean(String(process.env.CLOUDINARY_API_SECRET || '').trim()));
  return cloud && Boolean(String(process.env.INNGEST_EVENT_KEY || '').trim());
}

/** Tesseract in Node loads WASM; on serverless that often adds 15–30s+ per cold request. Set RECEIPT_TESSERACT=1 to enable (e.g. local). Vision-only (Gemini image) is the default. */
export function receiptTesseractEnabled() {
  const v = (process.env.RECEIPT_TESSERACT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const uploadsDir = path.join(os.tmpdir(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

function receiptImageFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const okMime =
    mime === 'image/jpg' || mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';
  const okExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  if (okMime || okExt) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG,JPEG, PNG, and WebP images are supported.'));
  }
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: receiptImageFileFilter,
});

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: receiptImageFileFilter,
});

const MULTI_UPLOAD_MAX_FILES = 10;

router.post('/upload-multiple', upload.array('receipts', MULTI_UPLOAD_MAX_FILES), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files uploaded. Use form field name "receipts".',
      });
    }

    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    const fileNames = files.map((f) =>
      typeof f.originalname === 'string' ? f.originalname : '',
    );

    const jobs = files.map((file, index) => ({
      name: `receipt_task_${Date.now()}_${index}`,
      data: {
        fileName: file.originalname,
        filePath: file.path,
        userId,
        status: 'pending',
      },
    }));

    if (receiptQueue) {
      try {
        const queuedJobs = await receiptQueue.addBulk(jobs);
        const jobIds = queuedJobs.map((j) => String(j.id));
        return res.status(202).json({
          success: true,
          message: 'Receipts added to processing queue.',
          count: queuedJobs.length,
          jobIds,
          fileNames,
        });
      } catch (queueErr) {
        console.warn(
          '[receipt] BullMQ addBulk failed; processing uploads in this request instead:',
          queueErr instanceof Error ? queueErr.message : queueErr,
        );
      }
    }

    const { processReceiptQueueJobData } = await import(
      '../services/queue/receiptQueueProcessor.js',
    );

    let completed = 0;
    let failed = 0;
    const jobsOut = [];
    const results = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const name = typeof file.originalname === 'string' ? file.originalname : '';
      try {
        const r = await processReceiptQueueJobData(
          {
            filePath: file.path,
            fileName: name,
            userId,
          },
          { applyMinSlot: i < files.length - 1 },
        );
        completed += 1;
        results.push({
          ok: true,
          fileName: name,
          receiptIds: r.receiptIds,
          warnings: r.warnings,
        });
        jobsOut.push({
          id: `inline-${i}`,
          state: 'completed',
          fileName: name,
        });
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : 'Processing failed';
        results.push({ ok: false, fileName: name, error: msg });
        jobsOut.push({
          id: `inline-${i}`,
          state: 'failed',
          fileName: name,
          failedReason: msg,
        });
        await fsp.unlink(file.path).catch(() => {});
      }
    }

    return res.status(200).json({
      success: true,
      processedInline: true,
      message: receiptQueue
        ? 'Queue unavailable; receipts were processed in this request.'
        : 'Receipts processed inline (BullMQ disabled via env).',
      count: files.length,
      jobIds: [],
      fileNames,
      summary: {
        total: files.length,
        completed,
        processing: 0,
        waiting: 0,
        failed,
      },
      jobs: jobsOut,
      results,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to queue receipts';
    console.error('Upload Error:', error);
    return res.status(500).json({ success: false, error: msg });
  }
});

/**
 * Same review rules as expense save: totals mismatch message, low confidence, or review flag.
 * @param {object} slip One slip after `applyReceiptValidation` (still has `receiptText` allowed).
 */
export function computeReceiptDraftReview(slip) {
  if (!slip || typeof slip !== 'object') {
    return { needsReview: true, reviewHint: '' };
  }
  const priced =
    Array.isArray(slip.items) &&
    slip.items.some(
      (item) =>
        item &&
        typeof item.price === 'number' &&
        !Number.isNaN(item.price),
    );
  const totalsCheck = validateTotals(slip.items || [], slip.total, slip.tax);
  const totalsInvalid = priced && !totalsCheck.isValid;
  const reviewHint = totalsInvalid
    ? 'Total does not match sum of line item prices.'
    : '';
  const conf =
    typeof slip.confidence === 'number' && !Number.isNaN(slip.confidence)
      ? slip.confidence
      : 0;
  const flagReview = slip.confidence_flag !== 'auto';
  const needsReview = flagReview || conf < 80 || Boolean(reviewHint);
  return { needsReview, reviewHint };
}

router.get('/jobs-status', async (req, res) => {
  try {
    if (!receiptQueue) {
      return res.status(503).json({
        success: false,
        error:
          'BullMQ is disabled (RECEIPT_USE_BULLMQ=0). Job status polling is not used for inline uploads.',
      });
    }

    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Query "ids" is required (comma-separated Bull job ids).',
      });
    }
    const userId = String(req.auth?.userId ?? '');
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    const jobs = [];

    for (const id of ids) {
      const job = await receiptQueue.getJob(id);
      if (!job) {
        jobs.push({ id, state: 'missing', fileName: '' });
        continue;
      }
      if (String(job.data?.userId ?? '') !== userId) {
        return res.status(403).json({
          success: false,
          error: 'One or more job ids do not belong to this account.',
        });
      }
      const state = await job.getState();
      const fileName =
        typeof job.data?.fileName === 'string' ? job.data.fileName : '';
      const row = { id, state, fileName };
      if (state === 'failed') {
        row.failedReason =
          typeof job.failedReason === 'string' ? job.failedReason : '';
      }
      jobs.push(row);
    }

    let completed = 0;
    let failed = 0;
    let processing = 0;
    let waiting = 0;
    for (const row of jobs) {
      if (row.state === 'active') {
        processing += 1;
      } else if (row.state === 'failed') {
        failed += 1;
      } else if (row.state === 'completed' || row.state === 'missing') {
        completed += 1;
      } else if (
        row.state === 'waiting' ||
        row.state === 'delayed' ||
        row.state === 'paused'
      ) {
        waiting += 1;
      } else {
        waiting += 1;
      }
    }

    const summary = {
      total: ids.length,
      completed,
      processing,
      waiting,
      failed,
    };

    return res.json({
      success: true,
      summary,
      jobs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Job status failed';
    return res.status(500).json({ success: false, error: message });
  }
});

function parseReceiptDraftsQuery(query) {
  const lim = parseInt(String(query.limit ?? ''), 10);
  const sk = parseInt(String(query.skip ?? ''), 10);
  const limit = Number.isFinite(lim) ? Math.min(Math.max(lim, 1), 100) : 50;
  const skip = Number.isFinite(sk) ? Math.max(sk, 0) : 0;
  return { limit, skip };
}

/** Receipt rows for this account (including linked + pending). */
router.get('/drafts', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    const { limit, skip } = parseReceiptDraftsQuery(req.query);
    const filter = {
      user: new mongoose.Types.ObjectId(userId),
    };
    const [receipts, totalCount] = await Promise.all([
      Receipt.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Receipt.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      receipts,
      totalCount,
      limit,
      skip,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'List failed';
    return res.status(500).json({ success: false, error: message });
  }
});

/** AI Studio keys use the free quota (no billing) until you enable paid billing in Google Cloud. */
const geminiModelId = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RAW_TEXT_MAX = 32_000;
export function capRawText(s) {
  if (typeof s !== 'string' || !s) return '';
  if (s.length <= RAW_TEXT_MAX) return s;
  return `${s.slice(0, RAW_TEXT_MAX)}\n…`;
}

/** Retries on Google’s transient overload (503). 429 / quota → throw (caller rotates API key). */
async function generateContentRetry503Only(model, content, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await model.generateContent(content);
    } catch (err) {
      if (isGeminiQuotaLikeError(err)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const transient503 =
        msg.includes('503') ||
        msg.includes('Service Unavailable') ||
        msg.includes('UNAVAILABLE');
      if (!transient503 || attempt === maxAttempts) {
        throw err;
      }
      await sleep(1500 * attempt);
    }
  }
}

/** Every `/upload` JSON body includes stable `rawText` + `aiParseFailed` (never undefined). */
function receiptJson(body) {
  const rawText = typeof body.rawText === 'string' ? body.rawText : '';
  const { rawText: _omit, ...rest } = body;
  return {
    ...rest,
    rawText,
    aiParseFailed: Boolean(body.aiParseFailed),
  };
}

function mapAiToReceiptFields(aiData) {
  const dateStr =
    aiData.date === '1970-01-01' || !aiData.date ? '' : String(aiData.date).trim();
  const date =
    dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? new Date(`${dateStr}T12:00:00.000Z`)
      : null;
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const items =
    Array.isArray(aiData.items) && aiData.items.length > 0
      ? aiData.items.map((i) => ({
          name: typeof i?.name === 'string' ? i.name : '',
          price:
            i?.price === null || i?.price === undefined || Number.isNaN(Number(i.price))
              ? null
              : Number(i.price),
          qty: numOrNull(i?.qty),
          unitPrice: numOrNull(i?.unitPrice),
        }))
      : [];
  const total =
    aiData.total === null ||
    aiData.total === undefined ||
    Number.isNaN(Number(aiData.total))
      ? null
      : Number(aiData.total);
  const taxRaw = aiData.tax;
  const taxNum =
    taxRaw === null || taxRaw === undefined || taxRaw === ''
      ? null
      : Number(taxRaw);
  const conf =
    typeof aiData.confidence === 'number' && !Number.isNaN(aiData.confidence)
      ? aiData.confidence
      : 0;
  return {
    vendor: typeof aiData.vendor === 'string' ? aiData.vendor : null,
    total,
    currency: typeof aiData.currency === 'string' ? aiData.currency : 'USD',
    date,
    tax: taxNum === null || Number.isNaN(taxNum) ? null : taxNum,
    items,
    confidence: conf,
  };
}

export async function createReceiptDraft(
  userId,
  { rawText, aiData, aiParseFailed, needsReview, reviewHint = '', processingStatus } = {},
) {
  const hint =
    typeof reviewHint === 'string' ? reviewHint.trim().slice(0, 2000) : '';
  const base = {
    user: new mongoose.Types.ObjectId(userId),
    rawText: typeof rawText === 'string' ? rawText : '',
    aiParseFailed: Boolean(aiParseFailed),
    needsReview: Boolean(needsReview),
    reviewHint: hint,
    expense: null,
  };
  const fields =
    aiData && typeof aiData === 'object' && !aiParseFailed
      ? mapAiToReceiptFields(aiData)
      : {
          vendor: null,
          total: null,
          currency: 'USD',
          date: null,
          tax: null,
          items: [],
          confidence: 0,
        };
  const statusExtra =
    processingStatus && ['pending', 'processing', 'completed', 'failed'].includes(processingStatus)
      ? { processingStatus }
      : {};
  const doc = await Receipt.create({ ...base, ...fields, ...statusExtra });
  return doc._id.toString();
}

export async function createPendingReceiptPlaceholder(userId, { imageUrl, cloudinaryPublicId }) {
  const doc = await Receipt.create({
    user: new mongoose.Types.ObjectId(userId),
    processingStatus: 'pending',
    imageUrl: typeof imageUrl === 'string' ? imageUrl : '',
    cloudinaryPublicId: typeof cloudinaryPublicId === 'string' ? cloudinaryPublicId : '',
    rawText: '',
    aiParseFailed: false,
    needsReview: true,
    reviewHint: '',
    expense: null,
    vendor: null,
    total: null,
    currency: 'USD',
    date: null,
    tax: null,
    items: [],
    confidence: 0,
  });
  return doc._id.toString();
}

/** Tesseract reads the original file (no server-side Sharp preprocessing). */
export async function prepareImageForOcr(originalPath) {
  return { ocrPath: originalPath, tempFile: null };
}

function ocrMeaningfulCharCount(s) {
  if (typeof s !== 'string' || !s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (/[A-Za-z0-9]/.test(s[i])) n += 1;
  }
  return n;
}

/** PSM 6 / 4 / 11 on one worker; pick best by mean confidence, then alphanumeric density, then length. */
export async function runReceiptOcr(ocrPath) {
  const Tesseract = (await import('tesseract.js')).default;
  const psms = [
    Tesseract.PSM.SINGLE_BLOCK,
    Tesseract.PSM.SINGLE_COLUMN,
    Tesseract.PSM.SPARSE_TEXT,
  ];
  let worker = null;
  try {
    worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      logger: () => {},
      errorHandler: () => {},
    });
    const candidates = [];
    for (const psm of psms) {
      try {
        const { data } = await worker.recognize(ocrPath, {
          tessedit_pageseg_mode: psm,
        });
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        const confidence =
          typeof data.confidence === 'number' && !Number.isNaN(data.confidence)
            ? data.confidence
            : -1;
        candidates.push({
          text,
          confidence,
          meaningful: ocrMeaningfulCharCount(text),
        });
      } catch {
        /* skip this PSM */
      }
    }
    if (candidates.length === 0) {
      return { rawText: '', ocrFailed: true };
    }
    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.meaningful !== a.meaningful) return b.meaningful - a.meaningful;
      return b.text.length - a.text.length;
    });
    const best = candidates[0].text;
    return {
      rawText: typeof best === 'string' ? best : String(best ?? ''),
      ocrFailed: false,
    };
  } catch {
    return { rawText: '', ocrFailed: true };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

function imageMimeType(file) {
  const { mimetype, originalname } = file;
  if (mimetype && mimetype.startsWith('image/')) return mimetype;
  const ext = path.extname(originalname || '').toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] || 'image/jpeg';
}

/** Max separate slips we create as Receipt drafts from one photo (cost + review UX). */
const MAX_RECEIPTS_PER_IMAGE = 5;

/**
 * Normalize Gemini JSON to a list of per-slip receipt objects.
 * - Preferred: `{ "receipts": [ { vendor, date, ... }, ... ] }`
 * - Legacy: one slip as a single object with vendor/items/total (no `receipts` key)
 */
function normalizeGeminiReceipts(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.receipts) && parsed.receipts.length > 0) {
    return parsed.receipts
      .filter((r) => r && typeof r === 'object')
      .slice(0, MAX_RECEIPTS_PER_IMAGE);
  }
  const looksLikeOneReceipt =
    typeof parsed.vendor === 'string' ||
    Array.isArray(parsed.items) ||
    parsed.total !== undefined;
  if (looksLikeOneReceipt && !parsed.receipts) {
    return [parsed];
  }
  return [];
}

async function getGeminiInlineData(filePath, fileMeta) {
  const fallbackMime = imageMimeType(fileMeta);
  try {
    const buf = await fsp.readFile(filePath);
    return { mimeType: fallbackMime, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

async function geminiVisionToReceipts(rawText, imagePart) {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    return {
      ok: false,
      error:
        'No Gemini API keys configured. Set GEMINI_API_KEY (comma-separated for multiple) or GEMINI_API_KEYS in `.env`.',
      code: 'GEMINI_NO_KEY',
      retryable: false,
    };
  }

  const prompt = `You analyze receipt image(s). Your input is (1) the receipt IMAGE and (2) OCR raw text below.

If the image is blurry, not a receipt, or unreadable, return exactly this JSON object and nothing else:
{"error":"UNREADABLE_IMAGE"}

MULTI-RECEIPT: The same photo may contain **several separate paper receipts** (e.g. stacked or side by side). Each distinct slip (different store, different totals block, or clearly separate document) must become **one object** inside the top-level "receipts" array — never merge two real slips into one. If only one slip is visible, return exactly **one** object in "receipts". Return at most ${MAX_RECEIPTS_PER_IMAGE} receipts.

PRIMARY RULE — trust the image first:
Use the IMAGE as the primary source of truth. Use the OCR text only as a hint (e.g. hard-to-read characters). If the OCR text is wrong, contradicts the image, or invents content, ignore it and trust the IMAGE.

Use the IMAGE as the source of truth for:
- Store / vendor name and logo text per slip
- Table layout: each line item row and any **price column** (read actual numbers from the image)
- Subtotals, tax, total — match printed numbers **for that slip only**

Never invent rows or prices from OCR alone. Do not treat OCR as authoritative.

STRICT RULES:
- Only extract items that are clearly visible on **that slip** in the image.
- Do NOT add or infer any item that is not explicitly visible.
- Do NOT replace item names with different real-world products.
- If text is unclear, keep it as-is or slightly normalize spelling, but do NOT change meaning or substitute products.
- If price not visible → null

GROUNDING RULES (MANDATORY):
- Every item in "items" MUST correspond to a visible row on **that** receipt slip.
- Do NOT invent items.
- Do NOT infer missing rows.
- If unsure about an item → exclude it.
- If unsure about a price → set it to null.

Per-slip output rules (repeat for each element of "receipts"):
- Return ONLY valid JSON. No markdown, no code fences, no extra text.
- date: YYYY-MM-DD from the printed date on that slip when possible; otherwise best effort from OCR; if none exists, use "1970-01-01".
- total and tax: numbers from that slip when printed.
- currency: ISO-style string when possible (e.g. USD); otherwise from symbol on that slip.
- items: one object per clearly visible charge row on that slip. "name" = text as printed (minor cleanup only).
- For each item, "price" is always the **line amount** for that row: the value in an Amount / Total / Extended price column, or the only price printed on that line when there is no separate unit column.
- When the receipt row clearly shows **quantity** and **unit price** (or rate) as separate columns from the line amount, also set "qty" and "unitPrice" (numbers). If those columns are absent or unreadable, set "qty" and "unitPrice" to null — do not copy the line amount into "unitPrice".
- When qty and unitPrice are both set, "price" should still match the printed line amount (or qty × unitPrice if that equals the printed amount).
- If that slip prints a SUBTOTAL that equals the sum of product lines above it, omit SUBTOTAL from "items" (do not double-count). Always include the grand TOTAL for that slip in "total".
- Do not invent prices.
- confidence / confidence_flag: optional; the server recomputes them using vendor +30, date +30, total +40, +5 when line prices match total, then caps if validation fails.
- receiptText: **only text visible on that slip** (store name, lines, numbers for that document). Do not append other slips' text into one slip's receiptText.

JSON shape (always use this wrapper):
{
  "receipts": [
    {
      "vendor": "string",
      "date": "YYYY-MM-DD",
      "total": number,
      "currency": "string",
      "tax": number | null,
      "items": [ { "name": "string", "price": number | null, "qty": number | null, "unitPrice": number | null } ],
      "confidence": number,
      "confidence_flag": "auto" | "review",
      "receiptText": "string"
    }
  ]
}

OCR raw text (hint only; may contain errors):
${JSON.stringify(rawText)}`;

  const MAX_JSON_ATTEMPTS = 3;

  keyRotation: for (let kAttempt = 0; kAttempt < keys.length; kAttempt += 1) {
    const keyIdx = peekGeminiKeyIndex(keys.length);
    const apiKey = keys[keyIdx];
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: geminiModelId,
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    let responseText;
    for (let jsonAttempt = 1; jsonAttempt <= MAX_JSON_ATTEMPTS; jsonAttempt += 1) {
      try {
        const result = await generateContentRetry503Only(model, [
          imagePart,
          { text: prompt },
        ]);
        responseText = result.response.text();
      } catch (err) {
        let message = err instanceof Error ? err.message : 'Gemini request failed';
        if (message.includes('503') || message.includes('high demand')) {
          message +=
            ' Try again in a few minutes, or set GEMINI_MODEL=gemini-2.5-flash-lite in .env.';
        }
        if (isGeminiQuotaLikeError(err)) {
          console.warn(
            `[Gemini] Quota/rate-limit on API key ${keyIdx + 1}/${keys.length}; rotating to next key.`,
          );
          advanceGeminiKeyIndexAfterQuota(keys.length);
          continue keyRotation;
        }
        return {
          ok: false,
          error: message,
          code: 'GEMINI_REQUEST_FAILED',
          retryable: true,
        };
      }

      let cleaned = responseText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/u, '')
          .trim();
      }

      try {
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object' && parsed.error === 'UNREADABLE_IMAGE') {
          return {
            ok: false,
            error: 'Image was unreadable.',
            code: 'UNREADABLE_IMAGE',
            retryable: false,
          };
        }
        const receipts = normalizeGeminiReceipts(parsed);
        if (receipts.length === 0) {
          throw new Error('empty receipts');
        }
        for (const slip of receipts) {
          applyReceiptValidation(slip);
        }
        advanceGeminiKeyIndexAfterSuccess(keys.length, keyIdx);
        return { ok: true, receipts };
      } catch {
        if (jsonAttempt < MAX_JSON_ATTEMPTS) {
          await sleep(400 * jsonAttempt);
        }
      }
    }

    return {
      ok: false,
      error: 'Gemini returned invalid JSON after multiple attempts. Try again.',
      code: 'GEMINI_JSON_INVALID',
      retryable: true,
    };
  }

  return {
    ok: false,
    error:
      'All configured Gemini API keys hit rate limit or quota. Wait and retry, or add more keys.',
    code: 'GEMINI_ALL_KEYS_QUOTA',
    retryable: true,
  };
}

export async function parseReceiptWithGemini(rawText, filePath, fileMeta) {
  let inline;
  if (fileMeta?.buffer && Buffer.isBuffer(fileMeta.buffer)) {
    inline = {
      mimeType: imageMimeType(fileMeta),
      data: fileMeta.buffer.toString('base64'),
    };
  } else if (filePath) {
    inline = await getGeminiInlineData(filePath, fileMeta);
  } else {
    return {
      ok: false,
      error: 'Could not read uploaded image for AI parsing.',
      code: 'IMAGE_READ_FAILED',
      retryable: true,
    };
  }
  if (!inline) {
    return {
      ok: false,
      error: 'Could not read uploaded image for AI parsing.',
      code: 'IMAGE_READ_FAILED',
      retryable: true,
    };
  }
  const imagePart = {
    inlineData: { mimeType: inline.mimeType, data: inline.data },
  };
  return geminiVisionToReceipts(rawText, imagePart);
}

export async function parseReceiptWithGeminiFromUrl(rawText, imageUrl) {
  const res = await fetch(String(imageUrl), { redirect: 'follow' });
  if (!res.ok) {
    return {
      ok: false,
      error: `Could not fetch image (${res.status}).`,
      code: 'IMAGE_FETCH_FAILED',
      retryable: true,
    };
  }
  const mimeHeader = res.headers.get('content-type') || 'image/jpeg';
  const mimeType = mimeHeader.split(';')[0].trim() || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  const imagePart = {
    inlineData: { mimeType, data: buf.toString('base64') },
  };
  return geminiVisionToReceipts(rawText, imagePart);
}

export async function finalizePendingReceiptsFromGemini(pendingReceiptId, userId, gemini) {
  const uid = new mongoose.Types.ObjectId(userId);
  const rid = new mongoose.Types.ObjectId(pendingReceiptId);

  if (!gemini || !gemini.ok) {
    const errMsg =
      gemini && typeof gemini.error === 'string' ? gemini.error : 'AI parse failed';
    const code = gemini?.code || 'GEMINI_FAILED';
    await Receipt.updateOne(
      { _id: rid, user: uid },
      {
        $set: {
          processingStatus: 'failed',
          processingError: errMsg.slice(0, 2000),
          aiParseFailed: true,
          needsReview: true,
        },
      },
    );
    return { ok: false, receiptIds: [String(rid)], code };
  }

  const slips = gemini.receipts;
  if (!Array.isArray(slips) || slips.length === 0) {
    await Receipt.updateOne(
      { _id: rid, user: uid },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'No receipts extracted',
          aiParseFailed: true,
          needsReview: true,
        },
      },
    );
    return { ok: false, receiptIds: [String(rid)], code: 'EMPTY_RECEIPTS' };
  }

  const createdIds = [];

  for (let i = 0; i < slips.length; i += 1) {
    const slip = { ...slips[i] };
    const visionTranscript =
      typeof slip.receiptText === 'string' ? String(slip.receiptText).trim() : '';
    delete slip.receiptText;
    const slipRaw = capRawText(visionTranscript);
    const { needsReview, reviewHint } = computeReceiptDraftReview(slip);
    const hint =
      typeof reviewHint === 'string' ? reviewHint.trim().slice(0, 2000) : '';
    const fields = mapAiToReceiptFields(slip);

    if (i === 0) {
      await Receipt.updateOne(
        { _id: rid, user: uid },
        {
          $set: {
            ...fields,
            rawText: slipRaw,
            aiParseFailed: false,
            needsReview,
            reviewHint: hint,
            processingStatus: 'completed',
            processingError: '',
            linkedReceiptIds: [],
          },
        },
      );
      createdIds.push(String(rid));
    } else {
      const newId = await createReceiptDraft(userId, {
        rawText: slipRaw,
        aiData: slip,
        aiParseFailed: false,
        needsReview,
        reviewHint: hint,
        processingStatus: 'completed',
      });
      createdIds.push(String(newId));
    }
  }

  if (createdIds.length > 1) {
    const extras = createdIds.slice(1).map((id) => new mongoose.Types.ObjectId(id));
    await Receipt.updateOne({ _id: rid, user: uid }, { $set: { linkedReceiptIds: extras } });
  }

  return { ok: true, receiptIds: createdIds };
}

router.get('/upload-status/:receiptId', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    const rid = String(req.params.receiptId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(rid)) {
      return res.status(400).json({ success: false, error: 'Invalid receipt id.' });
    }
    const primary = await Receipt.findOne({
      _id: new mongoose.Types.ObjectId(rid),
      user: new mongoose.Types.ObjectId(userId),
    }).lean();
    if (!primary) {
      return res.status(404).json({ success: false, error: 'Receipt not found.' });
    }

    const status = primary.processingStatus || 'completed';
    const out = {
      success: true,
      processingStatus: status,
      receiptId: String(primary._id),
    };

    if (status === 'pending' || status === 'processing') {
      return res.json(out);
    }

    if (status === 'failed') {
      return res.json({
        ...out,
        error: primary.processingError || 'Processing failed',
        aiParseFailed: Boolean(primary.aiParseFailed),
      });
    }

    const linked = Array.isArray(primary.linkedReceiptIds) ? primary.linkedReceiptIds : [];
    const ids = [primary._id, ...linked];
    const rows = await Receipt.find({
      _id: { $in: ids },
      user: new mongoose.Types.ObjectId(userId),
    })
      .sort({ createdAt: 1 })
      .lean();

    const toAiShape = (row) => ({
      vendor: row.vendor,
      total: row.total,
      currency: row.currency,
      date: row.date,
      tax: row.tax,
      items: row.items,
      confidence: row.confidence,
    });

    const created = rows.map((row) => {
      const slip = toAiShape(row);
      return {
        receiptId: String(row._id),
        aiData: slip,
        rawText: typeof row.rawText === 'string' ? row.rawText : '',
        reviewHint: typeof row.reviewHint === 'string' ? row.reviewHint : '',
        needsReview: Boolean(row.needsReview),
      };
    });

    const first = created[0];
    const combinedRaw = capRawText(
      created.map((c) => c.rawText).filter(Boolean).join('\n\n--- next receipt ---\n\n'),
    );
    const needsReviewAny = created.some((c) => c.needsReview);

    return res.json({
      ...out,
      ...receiptJson({
        success: true,
        rawText: combinedRaw,
        aiParseFailed: false,
        aiData: first?.aiData,
        ocrFailed: false,
        needsReview: needsReviewAny,
        receiptId: first?.receiptId,
        receiptIds: created.map((c) => c.receiptId),
        multiReceipt: created.length > 1,
        receipts: created,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Status failed';
    return res.status(500).json({ success: false, error: message });
  }
});

router.post(
  '/upload',
  (req, res, next) => {
    const multerSingle = receiptAsyncPipelineEnabled()
      ? uploadMemory.single('receipt')
      : upload.single('receipt');
    multerSingle(req, res, (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        return res.status(400).json(
          receiptJson({
            success: false,
            error: msg,
            code: 'INVALID_UPLOAD',
            rawText: '',
            aiParseFailed: true,
          }),
        );
      }
      if (!req.file) {
        return res.status(400).json(
          receiptJson({
            success: false,
            error: 'No file uploaded. Use form field name "receipt".',
            code: 'NO_FILE',
            rawText: '',
            aiParseFailed: true,
          }),
        );
      }
      next();
    });
  },
  async (req, res) => {
    const filePath = req.file.path ? path.resolve(req.file.path) : null;
    let tempFile = null;

    try {
      if (receiptAsyncPipelineEnabled()) {
        const buf = req.file.buffer;
        if (!buf || !Buffer.isBuffer(buf)) {
          return res.status(500).json(
            receiptJson({
              success: false,
              error: 'Internal upload error (buffer missing).',
              code: 'INTERNAL_ERROR',
              rawText: '',
              aiParseFailed: true,
            }),
          );
        }
        const userId = req.auth.userId;
        const { url, publicId } = await uploadReceiptImageBuffer(buf, {
          userId,
          originalFilename: req.file.originalname,
        });
        const receiptId = await createPendingReceiptPlaceholder(userId, {
          imageUrl: url,
          cloudinaryPublicId: publicId,
        });
        await inngest.send({
          name: 'receipt/uploaded',
          data: { receiptId, imageUrl: url, userId: String(userId) },
        });
        return res.status(202).json({
          success: true,
          accepted: true,
          processingStatus: 'pending',
          receiptId,
          pollUrl: `/api/receipt/upload-status/${receiptId}`,
          message: 'Receipt queued for processing.',
        });
      }

      if (!filePath) {
        return res.status(500).json(
          receiptJson({
            success: false,
            error: 'Upload path missing.',
            code: 'INTERNAL_ERROR',
            rawText: '',
            aiParseFailed: true,
          }),
        );
      }

      let rawText = '';
      let ocrFailed = true;

      if (receiptTesseractEnabled()) {
        const prep = await prepareImageForOcr(filePath);
        const { ocrPath } = prep;
        tempFile = prep.tempFile;
        try {
          const ocr = await runReceiptOcr(ocrPath);
          rawText = typeof ocr.rawText === 'string' ? ocr.rawText : '';
          ocrFailed = Boolean(ocr.ocrFailed);
        } catch {
          rawText = '';
          ocrFailed = true;
        }
      } else {
        rawText = '';
        ocrFailed = false;
      }

      const gemini = await parseReceiptWithGemini(rawText, filePath, req.file);

      if (!gemini.ok) {
        if (ocrFailed) {
          return res.status(200).json(
            receiptJson({
              success: false,
              rawText: '',
              aiParseFailed: true,
              error: 'OCR failed',
              code: 'OCR_FAILED',
              retryable: true,
            }),
          );
        }
        const receiptId = await createReceiptDraft(req.auth.userId, {
          rawText,
          aiData: null,
          aiParseFailed: true,
          needsReview: true,
        });
        return res.status(200).json(
          receiptJson({
            success: false,
            rawText,
            aiParseFailed: true,
            error: typeof gemini.error === 'string' ? gemini.error : 'AI parse failed',
            code: gemini.code || 'GEMINI_FAILED',
            retryable: gemini.retryable !== false,
            needsReview: true,
            receiptId,
          }),
        );
      }

      /** Step 3 (upload): one DB Receipt draft per slip; client gets ordered list for review queue. */
      const { receipts } = gemini;
      const ocrOrHint = String(rawText || '').trim();
      const created = [];

      for (let i = 0; i < receipts.length; i += 1) {
        const slip = { ...receipts[i] };
        const visionTranscript =
          typeof slip.receiptText === 'string' ? String(slip.receiptText).trim() : '';
        delete slip.receiptText;
        const slipRaw = capRawText(
          visionTranscript || (i === 0 ? ocrOrHint : ''),
        );
        const { needsReview, reviewHint } = computeReceiptDraftReview(slip);
        const receiptId = await createReceiptDraft(req.auth.userId, {
          rawText: slipRaw,
          aiData: slip,
          aiParseFailed: false,
          needsReview,
          reviewHint,
        });
        created.push({
          receiptId,
          aiData: { ...slip },
          rawText: slipRaw,
          reviewHint,
          needsReview,
        });
      }

      const combinedRaw = capRawText(
        created.map((c) => c.rawText).filter(Boolean).join('\n\n--- next receipt ---\n\n'),
      );
      const needsReviewAny = created.some((c) => c.needsReview);
      const first = created[0];

      return res.json(
        receiptJson({
          success: true,
          rawText: combinedRaw,
          aiParseFailed: false,
          aiData: first.aiData,
          ocrFailed,
          needsReview: needsReviewAny,
          receiptId: first.receiptId,
          receiptIds: created.map((c) => c.receiptId),
          multiReceipt: created.length > 1,
          receipts: created.map((c) => ({
            receiptId: c.receiptId,
            aiData: c.aiData,
            rawText: c.rawText,
            reviewHint: c.reviewHint,
          })),
        }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Receipt processing failed';
      if (!res.headersSent) {
        res.status(500).json(
          receiptJson({
            success: false,
            rawText: '',
            aiParseFailed: true,
            error: message,
            code: 'INTERNAL_ERROR',
          }),
        );
      }
    } finally {
      if (filePath) await fsp.unlink(filePath).catch(() => {});
      if (tempFile) await fsp.unlink(tempFile).catch(() => {});
    }
  },
);

export default router;
