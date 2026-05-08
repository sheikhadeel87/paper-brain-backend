import { Queue } from 'bullmq'
import { createBullmqRedisConnection } from './redisConnection.js'

/**
 * Set `RECEIPT_USE_BULLMQ=0` or `RECEIPT_INLINE_ONLY=1` to skip Redis entirely:
 * `/upload-multiple` runs processing in the HTTP request (same as pre-queue behavior).
 */
export const receiptQueueEnabled =
  process.env.RECEIPT_USE_BULLMQ !== '0' &&
  process.env.RECEIPT_INLINE_ONLY !== '1'

export const receiptQueue = receiptQueueEnabled
  ? new Queue('receipt-processing', {
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
  : null
