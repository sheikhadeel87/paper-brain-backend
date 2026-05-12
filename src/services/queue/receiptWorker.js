import { DelayedError, Worker } from 'bullmq'
import { logGeminiKeyPool } from '../../lib/geminiApiKeyPool.js'
import { createBullmqRedisConnection } from './redisConnection.js'
import { receiptQueueEnabled } from './receiptQueue.js'
import { getReceiptWorkerConcurrency } from './receiptWorkerConcurrency.js'

let connection = null
/** Separate connection for lock keys so we never interleave with BullMQ’s use of `connection`. */
let lockRedis = null

const USER_SERIAL_LOCK_PREFIX = 'paper-brain:receipt:user-serial:'
const USER_LOCK_TTL_MS = 15 * 60 * 1000
/** When another worker holds the per-user lock, re-queue this job so it is not stuck in `active`. */
const USER_LOCK_RETRY_DELAY_MS = 750

const UNLOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`

const workerConcurrency = getReceiptWorkerConcurrency()

export const receiptWorker = receiptQueueEnabled
  ? (() => {
      connection = createBullmqRedisConnection('worker')
      lockRedis = connection.duplicate()
      return new Worker(
        'receipt-processing',
        async (job, token) => {
          const { processReceiptQueueJobData } = await import(
            './receiptQueueProcessor.js',
          )
          const name = job.data?.fileName ?? job.id
          const userId = job.data?.userId
          const uid = String(userId || '').trim() || 'anonymous'
          const lockKey = `${USER_SERIAL_LOCK_PREFIX}${uid}`
          const lockVal = `${process.pid}:${String(job.id)}`

          const acquired = await lockRedis.set(
            lockKey,
            lockVal,
            'PX',
            USER_LOCK_TTL_MS,
            'NX',
          )
          if (acquired !== 'OK') {
            await job.moveToDelayed(
              Date.now() + USER_LOCK_RETRY_DELAY_MS,
              token,
            )
            throw new DelayedError()
          }

          console.log(`[Worker] Processing: ${name}`)
          try {
            return await processReceiptQueueJobData(job.data, {
              applyMinSlot: true,
            })
          } finally {
            try {
              await lockRedis.eval(UNLOCK_LUA, 1, lockKey, lockVal)
            } catch (e) {
              console.warn(
                '[receiptWorker] user lock release failed:',
                e?.message || e,
              )
            }
          }
        },
        {
          connection,
          concurrency: workerConcurrency,
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

  receiptWorker.on('ready', () => {
    logGeminiKeyPool('receiptWorker')
    console.log(
      `[receiptWorker] ready — queue "receipt-processing" (concurrency=${workerConcurrency}, per-user Redis lock)`,
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
    '[receiptWorker] BullMQ worker not started — receipt uploads run inline in HTTP (Vercel default, or RECEIPT_USE_BULLMQ=0 / RECEIPT_INLINE_ONLY=1). Set RECEIPT_USE_BULLMQ=1 with Redis on a long-running host to use the queue.',
  )
}
