import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import { applyReceiptValidation } from '../lib/receiptValidation.js';
import { Receipt } from '../models/Receipt.js';
import { processTimingMiddleware } from '../middleware/processTiming.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();
router.use(processTimingMiddleware);
router.use(requireAuth);

/** Tesseract in Node loads WASM; on serverless that often adds 15–30s+ per cold request. Set RECEIPT_TESSERACT=1 to enable (e.g. local). Vision-only (Gemini image) is the default. */
function receiptTesseractEnabled() {
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

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
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
  },
});

/** AI Studio keys use the free quota (no billing) until you enable paid billing in Google Cloud. */
const geminiModelId = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RAW_TEXT_MAX = 32_000;
function capRawText(s) {
  if (typeof s !== 'string' || !s) return '';
  if (s.length <= RAW_TEXT_MAX) return s;
  return `${s.slice(0, RAW_TEXT_MAX)}\n…`;
}

/** Retries on Google’s transient overload (503) and rate limits (429). */
async function generateContentWithRetry(model, content, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await model.generateContent(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('Service Unavailable') ||
        msg.includes('Too Many Requests') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('RESOURCE_EXHAUSTED');
      if (!transient || attempt === maxAttempts) {
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

async function createReceiptDraft(userId, { rawText, aiData, aiParseFailed, needsReview }) {
  const base = {
    user: new mongoose.Types.ObjectId(userId),
    rawText: typeof rawText === 'string' ? rawText : '',
    aiParseFailed: Boolean(aiParseFailed),
    needsReview: Boolean(needsReview),
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
  const doc = await Receipt.create({ ...base, ...fields });
  return doc._id.toString();
}

/** Temp PNG for Tesseract only; Gemini still uses the original upload path. */
async function prepareImageForOcr(originalPath) {
  const dir = path.dirname(originalPath);
  const stem = path.basename(originalPath, path.extname(originalPath));
  const outPath = path.join(dir, `${stem}-ocr.png`);
  try {
    await sharp(originalPath)
      .rotate()
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(150)
      .png()
      .toFile(outPath);
    return { ocrPath: outPath, tempFile: outPath };
  } catch {
    return { ocrPath: originalPath, tempFile: null };
  }
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
async function runReceiptOcr(ocrPath) {
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

/** Downscale for Gemini. Full-resolution phone photos bloat the request and can exceed serverless time limits. */
const GEMINI_MAX_EDGE = 1920;

async function getGeminiInlineData(filePath, fileMeta) {
  const fallbackMime = imageMimeType(fileMeta);
  try {
    const out = await sharp(filePath)
      .rotate()
      .resize(GEMINI_MAX_EDGE, GEMINI_MAX_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    return { mimeType: 'image/jpeg', data: out.toString('base64') };
  } catch {
    try {
      const buf = await fsp.readFile(filePath);
      return { mimeType: fallbackMime, data: buf.toString('base64') };
    } catch {
      return null;
    }
  }
}

async function parseReceiptWithGemini(rawText, filePath, fileMeta) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return {
      ok: false,
      error:
        'GEMINI_API_KEY is not set. Add it to `.env` at the project root or `backend/.env` (see `.env.example`).',
      code: 'GEMINI_NO_KEY',
      retryable: false,
    };
  }

  const inline = await getGeminiInlineData(filePath, fileMeta);
  if (!inline) {
    return {
      ok: false,
      error: 'Could not read uploaded image for AI parsing.',
      code: 'IMAGE_READ_FAILED',
      retryable: true,
    };
  }
  const { mimeType, data: imageBase64 } = inline;

  const prompt = `You analyze a receipt. Your input is (1) the receipt IMAGE and (2) OCR raw text below.

PRIMARY RULE — trust the image first:
Use the IMAGE as the primary source of truth. Use the OCR text only as a hint (e.g. hard-to-read characters). If the OCR text is wrong, contradicts the image, or invents content, ignore it and trust the IMAGE.

Use the IMAGE as the source of truth for:
- Store / vendor name and logo text
- Table layout: each line item row and any **price column** (read actual numbers from the image)
- Subtotals, tax, total — match printed numbers on the receipt

Never invent rows or prices from OCR alone. Do not treat OCR as authoritative.

STRICT RULES:
- Only extract items that are clearly visible in the image.
- Do NOT add or infer any item that is not explicitly visible.
- Do NOT replace item names with different real-world products.
- If text is unclear, keep it as-is or slightly normalize spelling, but do NOT change meaning or substitute products.
- If price not visible → null

GROUNDING RULES (MANDATORY):
- Every item in "items" MUST correspond to a visible row in the receipt image.
- Do NOT invent items.
- Do NOT infer missing rows.
- If unsure about an item → exclude it.
- If unsure about a price → set it to null.

Output rules:
- Return ONLY valid JSON. No markdown, no code fences, no extra text.
- date: YYYY-MM-DD from the printed date on the image when possible; otherwise best effort from OCR; if none exists, use "1970-01-01".
- total and tax: numbers from the receipt image when printed.
- currency: ISO-style string when possible (e.g. USD); otherwise from symbol on the image.
- items: one object per clearly visible charge row (products, delivery/service fees, tips, tax lines when printed with an amount). "name" = text as printed (minor cleanup only).
- For each item, "price" is always the **line amount** for that row: the value in an Amount / Total / Extended price column, or the only price printed on that line when there is no separate unit column.
- When the receipt row clearly shows **quantity** and **unit price** (or rate) as separate columns from the line amount, also set "qty" and "unitPrice" (numbers). If those columns are absent or unreadable, set "qty" and "unitPrice" to null — do not copy the line amount into "unitPrice".
- When qty and unitPrice are both set, "price" should still match the printed line amount (or qty × unitPrice if that equals the printed amount).
- If the receipt prints a SUBTOTAL that equals the sum of product lines above it, omit SUBTOTAL from "items" (do not double-count). Always include the grand TOTAL in the "total" field, not as a duplicate line unless it is the only way it appears.
- Do not invent prices.
- confidence / confidence_flag: optional; the server recomputes them using vendor +30, date +30, total +40, +5 when line prices match total, then caps if validation fails.
- receiptText: a single string of **all legible printed text** from the image, top to bottom (store name, line labels, numbers, tax lines). For audit/search. When there is no separate OCR hint, this is the only plain-text copy of the receipt.

JSON shape:
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

OCR raw text (hint only; may contain errors):
${JSON.stringify(rawText)}`;

  const imagePart = {
    inlineData: { mimeType, data: imageBase64 },
  };

  let responseText;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: geminiModelId,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const MAX_JSON_ATTEMPTS = 3;
  for (let jsonAttempt = 1; jsonAttempt <= MAX_JSON_ATTEMPTS; jsonAttempt += 1) {
    try {
      const result = await generateContentWithRetry(model, [imagePart, { text: prompt }]);
      responseText = result.response.text();
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Gemini request failed';
      if (message.includes('503') || message.includes('high demand')) {
        message +=
          ' Try again in a few minutes, or set GEMINI_MODEL=gemini-2.5-flash-lite in .env.';
      }
      if (message.includes('429') || message.includes('Too Many Requests')) {
        message += ' Wait for the retry window or use GEMINI_MODEL=gemini-2.5-flash-lite.';
      }
      return { ok: false, error: message, code: 'GEMINI_REQUEST_FAILED', retryable: true };
    }

    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '').trim();
    }

    try {
      const aiData = JSON.parse(cleaned);
      applyReceiptValidation(aiData);
      return { ok: true, aiData };
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

router.post(
  '/upload',
  (req, res, next) => {
    upload.single('receipt')(req, res, (err) => {
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
    const filePath = path.resolve(req.file.path);
    let tempFile = null;

    try {
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
        // Gemini prompt uses the image as primary; OCR is optional hardening only.
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

      const { aiData } = gemini;
      const visionTranscript =
        typeof aiData.receiptText === 'string'
          ? String(aiData.receiptText).trim()
          : '';
      delete aiData.receiptText;
      const ocrOrHint = String(rawText || '').trim();
      const combinedRaw = capRawText(ocrOrHint || visionTranscript);

      const receiptId = await createReceiptDraft(req.auth.userId, {
        rawText: combinedRaw,
        aiData,
        aiParseFailed: false,
        needsReview: aiData.confidence_flag === 'review',
      });
      return res.json(
        receiptJson({
          success: true,
          rawText: combinedRaw,
          aiParseFailed: false,
          aiData,
          ocrFailed,
          needsReview: aiData.confidence_flag === 'review',
          receiptId,
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
      await fsp.unlink(filePath).catch(() => {});
      if (tempFile) await fsp.unlink(tempFile).catch(() => {});
    }
  },
);

export default router;
