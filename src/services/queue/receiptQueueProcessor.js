import fsp from 'node:fs/promises'
import mongoose from 'mongoose'
import {
  capRawText,
  computeReceiptDraftReview,
  createReceiptDraft,
  parseReceiptWithGemini,
  parseReceiptWithGeminiFromUrl,
  prepareImageForOcr,
  receiptTesseractEnabled,
  runReceiptOcr,
} from '../../routes/receipt.js'
import { Expense } from '../../models/Expense.js'
import { Receipt } from '../../models/Receipt.js'
import {
  markUserReceiptPersistTime,
  waitForUserReceiptPersistSlot,
} from './receiptUserPersistThrottle.js'
import {
  DEFAULT_RECEIPT_CATEGORY,
  normalizeReceiptCategory,
} from '../../lib/receiptCategories.js'
import { categorizeReceipt } from '../receiptCategorization.js'

export { receiptQueueMinSlotMs } from '../../lib/receiptQueueSlotMs.js'

/**
 * OCR + Gemini + draft rows — shared by BullMQ worker and inline `/upload-multiple` fallback.
 * Pass either `filePath` (disk, from multipart) **or** `imageUrl` (Cloudinary URL, single async upload).
 * Receipt + Expense rows are created only after Gemini succeeds.
 * @param {{ filePath?: string, imageUrl?: string, cloudinaryPublicId?: string, fileName: string, userId: string }} jobData
 * @param {{ applyMinSlot?: boolean }} [options] — default `true` (min wall time between **Receipt** inserts per user, after Gemini, before `createReceiptDraft`; `RECEIPT_QUEUE_MIN_SLOT_MS`).
 */
export async function processReceiptQueueJobData(jobData, options = {}) {
  const applyMinSlot = options.applyMinSlot !== false
  const {
    filePath: fpIn,
    fileName,
    userId,
    imageUrl: imageUrlIn,
    cloudinaryPublicId: cloudIn,
  } = jobData
  const filePath = typeof fpIn === 'string' && fpIn.trim() !== '' ? fpIn.trim() : ''
  const imageUrl = typeof imageUrlIn === 'string' ? imageUrlIn.trim() : ''
  const cloudinaryPublicId = typeof cloudIn === 'string' ? cloudIn.trim() : ''
  const fromCloudinaryUrl = Boolean(imageUrl) && !filePath
  let tempFile = null

  try {
    let rawText = ''
    let ocrFailed = true
    let gemini

    if (fromCloudinaryUrl) {
      rawText = ''
      ocrFailed = false
      gemini = await parseReceiptWithGeminiFromUrl('', imageUrl)
    } else {
      if (!filePath) {
        throw new Error('Queue job missing filePath and imageUrl')
      }
      if (receiptTesseractEnabled()) {
        const prep = await prepareImageForOcr(filePath)
        const { ocrPath } = prep
        tempFile = prep.tempFile
        try {
          const ocr = await runReceiptOcr(ocrPath)
          rawText = typeof ocr.rawText === 'string' ? ocr.rawText : ''
          ocrFailed = Boolean(ocr.ocrFailed)
        } catch {
          rawText = ''
          ocrFailed = true
        }
      } else {
        rawText = ''
        ocrFailed = false
      }

      gemini = await parseReceiptWithGemini(rawText, filePath, {
        originalname: fileName,
        mimetype: '',
      })
    }

    if (!gemini.ok) {
      const reason =
        typeof gemini.error === 'string' ? gemini.error : 'AI parse failed'
      throw new Error(
        `${reason}${ocrFailed ? ' (OCR fallback failed)' : ''}`,
      )
    }

    if (applyMinSlot) {
      await waitForUserReceiptPersistSlot(userId)
    }

    const receiptIds = []
    const warnings = []
    const expenseIds = []

    for (let i = 0; i < gemini.receipts.length; i += 1) {
      const slip = gemini.receipts[i]
      const aiData = { ...slip }
      const visionTranscript =
        typeof aiData.receiptText === 'string'
          ? String(aiData.receiptText).trim()
          : ''
      const slipForDb = { ...aiData }
      delete slipForDb.receiptText
      const existingCategory = normalizeReceiptCategory(slipForDb.category)
      const category =
        existingCategory !== DEFAULT_RECEIPT_CATEGORY || slipForDb.category === DEFAULT_RECEIPT_CATEGORY
          ? existingCategory
          : await categorizeReceipt({
              merchant: slipForDb.vendor,
              items: slipForDb.items,
              total: slipForDb.total,
            })
      slipForDb.category = normalizeReceiptCategory(category)
      slipForDb.categorySource = 'AI'

      const slipRaw = capRawText(
        visionTranscript || rawText || `OCR Text for ${fileName}`,
      )

      const { needsReview, reviewHint } = computeReceiptDraftReview(slipForDb)
      const draftOpts = {
        rawText: slipRaw,
        aiData: slipForDb,
        aiParseFailed: false,
        needsReview,
        reviewHint,
      }
      if (fromCloudinaryUrl && i === 0) {
        draftOpts.imageUrl = imageUrl
        draftOpts.cloudinaryPublicId = cloudinaryPublicId
      }
      const receiptId = await createReceiptDraft(userId, draftOpts)
      receiptIds.push(String(receiptId))
      if (reviewHint) {
        warnings.push({ receiptId: String(receiptId), message: reviewHint })
      }
      const confidence =
        typeof slipForDb.confidence === 'number' &&
        !Number.isNaN(slipForDb.confidence)
          ? slipForDb.confidence
          : 0
      const confidenceFlag =
        slipForDb.confidence_flag === 'auto' ? 'auto' : 'review'
      const expense = await Expense.create({
        user: userId,
        rawText: slipRaw,
        originalAiData: slipForDb,
        finalData: slipForDb,
        confidence,
        confidenceFlag,
        isCorrected: false,
        status: 'approved',
      })
      await Receipt.updateOne(
        { _id: receiptId, user: userId },
        { $set: { expense: expense._id } },
      )
      expenseIds.push(String(expense._id))
    }

    if (receiptIds.length > 1) {
      const extras = receiptIds
        .slice(1)
        .map((id) => new mongoose.Types.ObjectId(String(id)))
      await Receipt.updateOne(
        {
          _id: new mongoose.Types.ObjectId(String(receiptIds[0])),
          user: new mongoose.Types.ObjectId(String(userId)),
        },
        { $set: { linkedReceiptIds: extras } },
      )
    }

    if (applyMinSlot) {
      await markUserReceiptPersistTime(userId)
    }
    return { success: true, receiptIds, warnings, expenseIds }
  } finally {
    if (filePath) await fsp.unlink(filePath).catch(() => {})
    if (tempFile) await fsp.unlink(tempFile).catch(() => {})
  }
}
