import { Worker } from 'bullmq'
import { logGeminiKeyPool } from '../../lib/geminiApiKeyPool.js'
import { createBullmqRedisConnection } from './redisConnection.js'
import { receiptQueueEnabled } from './receiptQueue.js'

let connection = null

export const receiptWorker = receiptQueueEnabled
  ? (() => {
      connection = createBullmqRedisConnection()
      return new Worker(
        'receipt-processing',
        async (job) => {
          const { processReceiptQueueJobData } = await import(
            './receiptQueueProcessor.js',
          )
          const name = job.data?.fileName ?? job.id
          console.log(`[Worker] Processing: ${name}`)
          return processReceiptQueueJobData(job.data, { applyMinSlot: true })
        },
        {
          connection,
          concurrency: 1,
        },
      )
    })()
  : null

if (receiptWorker) {
  receiptWorker.on('completed', (job, result) => {
    const ids = Array.isArray(result?.receiptIds) ? result.receiptIds : []
    console.log(
      `✅ Job ${job.id} completed. Receipt draft IDs: ${ids.join(', ')}`,
    )
  })

  receiptWorker.on('failed', (job, err) => {
    console.log(`❌ Job ${job?.id ?? 'unknown'} failed: ${err.message}`)
  })

  receiptWorker.on('error', (err) => {
    console.error('[receiptWorker] worker error:', err?.message || err)
  })

  connection.on('error', (err) => {
    console.error(
      '[receiptWorker] redis connection error:',
      err?.message || err,
    )
  })

  receiptWorker.on('ready', () => {
    logGeminiKeyPool('receiptWorker')
    console.log(
      '[receiptWorker] ready — consuming queue "receipt-processing"',
    )
  })

  connection
    .ping()
    .then((p) => console.log('[receiptWorker] redis PING:', p))
    .catch((e) => {
      console.error(
        '[receiptWorker] redis PING failed — jobs stay "waiting" until Redis is up:',
        e?.message || e,
      )
    })
} else {
  console.log(
    '[receiptWorker] BullMQ worker not started (RECEIPT_USE_BULLMQ=0 or RECEIPT_INLINE_ONLY=1). Use inline upload processing.',
  )
}
