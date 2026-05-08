import fsp from 'node:fs/promises'
import {
  capRawText,
  computeReceiptDraftReview,
  createReceiptDraft,
  parseReceiptWithGemini,
  prepareImageForOcr,
  receiptTesseractEnabled,
  runReceiptOcr,
} from '../../routes/receipt.js'
import { Expense } from '../../models/Expense.js'
import { Receipt } from '../../models/Receipt.js'

/** Same env as worker: optional delay after each job (queue mode only; inline skips). */
export function receiptQueueMinSlotMs() {
  return Math.max(
    0,
    parseInt(
      String(
        process.env.RECEIPT_QUEUE_MIN_SLOT_MS ??
          process.env.RECEIPT_QUEUE_INTER_JOB_DELAY_MS ??
          '60000',
      ),
      10,
    ) || 0,
  )
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * OCR + Gemini + draft rows — shared by BullMQ worker and inline `/upload-multiple` fallback.
 * @param {{ filePath: string, fileName: string, userId: string }} jobData
 * @param {{ applyMinSlot?: boolean }} [options] — set `false` for HTTP inline processing.
 */
export async function processReceiptQueueJobData(jobData, options = {}) {
  const applyMinSlot = options.applyMinSlot !== false
  const slotStart = Date.now()
  const { filePath, fileName, userId } = jobData
  let tempFile = null

  try {
    let rawText = ''
    let ocrFailed = true
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

    const gemini = await parseReceiptWithGemini(rawText, filePath, {
      originalname: fileName,
      mimetype: '',
    })
    if (!gemini.ok) {
      const reason =
        typeof gemini.error === 'string' ? gemini.error : 'AI parse failed'
      throw new Error(
        `${reason}${ocrFailed ? ' (OCR fallback failed)' : ''}`,
      )
    }

    const receiptIds = []
    const warnings = []
    const expenseIds = []

    for (const slip of gemini.receipts) {
      const aiData = { ...slip }
      const visionTranscript =
        typeof aiData.receiptText === 'string'
          ? String(aiData.receiptText).trim()
          : ''
      const slipForDb = { ...aiData }
      delete slipForDb.receiptText

      const slipRaw = capRawText(
        visionTranscript || rawText || `OCR Text for ${fileName}`,
      )

      const { needsReview, reviewHint } = computeReceiptDraftReview(slipForDb)
      const receiptId = await createReceiptDraft(userId, {
        rawText: slipRaw,
        aiData: slipForDb,
        aiParseFailed: false,
        needsReview,
        reviewHint,
      })
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

    return { success: true, receiptIds, warnings, expenseIds }
  } finally {
    await fsp.unlink(filePath).catch(() => {})
    if (tempFile) await fsp.unlink(tempFile).catch(() => {})
    if (applyMinSlot) {
      const MIN_SLOT_MS = receiptQueueMinSlotMs()
      if (MIN_SLOT_MS > 0) {
        const elapsed = Date.now() - slotStart
        const pad = Math.max(0, MIN_SLOT_MS - elapsed)
        if (pad > 0) {
          await sleep(pad)
        }
      }
    }
  }
}
