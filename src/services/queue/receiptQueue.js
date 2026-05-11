import { createBullmqRedisConnection } from './redisConnection.js'

/**
 * BullMQ + Redis worker does not fit Vercel serverless well (no long-lived worker,
 * cold starts, Redis from every region). On Vercel (`VERCEL=1`), the queue is **off**
 * unless you explicitly set `RECEIPT_USE_BULLMQ=1` and configure Redis — same behavior
 * as before Redis: `/upload-multiple` runs inline in the HTTP request.
 *
 * Elsewhere: set `RECEIPT_USE_BULLMQ=0` or `RECEIPT_INLINE_ONLY=1` to skip Redis.
 *
 * Dynamic `import('bullmq')` so Vercel bundles without loading `bullmq` when the queue
 * is disabled (default on serverless) — avoids ERR_MODULE_NOT_FOUND for unused deps.
 */
const onVercel = process.env.VERCEL === '1'
const bullMqExplicitOn = process.env.RECEIPT_USE_BULLMQ === '1'
const bullMqExplicitOff = process.env.RECEIPT_USE_BULLMQ === '0'
const inlineOnly = process.env.RECEIPT_INLINE_ONLY === '1'

export const receiptQueueEnabled =
  !bullMqExplicitOff &&
  !inlineOnly &&
  (!onVercel || bullMqExplicitOn)

export const receiptQueue = await (async () => {
  if (!receiptQueueEnabled) return null
  const { Queue } = await import('bullmq')
  return new Queue('receipt-processing', {
    connection: createBullmqRedisConnection('queue'),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000,
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  })
})()
