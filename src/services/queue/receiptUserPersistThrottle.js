import { receiptQueueMinSlotMs } from '../../lib/receiptQueueSlotMs.js'
import { createBullmqRedisConnection } from './redisConnection.js'

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

let throttleRedis = null

function getThrottleRedis() {
  if (!throttleRedis) {
    throttleRedis = createBullmqRedisConnection('receipt-persist-throttle')
  }
  return throttleRedis
}

const LAST_PERSIST_KEY_PREFIX = 'paper-brain:receipt:user-last-persist:'
/** Avoid unbounded Redis growth if a user stops uploading. */
const LAST_PERSIST_TTL_MS = 48 * 60 * 60 * 1000

/**
 * Enforces a minimum wall time between **successful** `Receipt` persists for a user
 * (see `markUserReceiptPersistTime`). Call **before** Gemini / `createReceiptDraft` so
 * Mongo `createdAt` reflects the intended cadence; safe across multiple worker processes.
 */
export async function waitForUserReceiptPersistSlot(userId) {
  const slotMs = receiptQueueMinSlotMs()
  if (slotMs <= 0) return
  const uid = String(userId ?? '').trim()
  if (!uid) return
  let redis
  try {
    redis = getThrottleRedis()
  } catch {
    return
  }
  const key = LAST_PERSIST_KEY_PREFIX + uid
  let raw
  try {
    raw = await redis.get(key)
  } catch {
    return
  }
  const last = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(last)) return
  const waitMs = Math.max(0, slotMs - (Date.now() - last))
  if (waitMs > 0) await sleep(waitMs)
}

/** Call once after all receipt rows for this queue job have been inserted. */
export async function markUserReceiptPersistTime(userId) {
  const uid = String(userId ?? '').trim()
  if (!uid) return
  let redis
  try {
    redis = getThrottleRedis()
  } catch {
    return
  }
  const key = LAST_PERSIST_KEY_PREFIX + uid
  try {
    await redis.set(key, String(Date.now()), 'PX', LAST_PERSIST_TTL_MS)
  } catch {
    /* non-fatal */
  }
}
