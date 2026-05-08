import IORedis from 'ioredis'

/**
 * New Redis connection for BullMQ — use one instance per Queue / Worker.
 * @see https://docs.bullmq.io/guide/connections
 */
export function createBullmqRedisConnection() {
  const url = String(process.env.REDIS_URL || '').trim()
  if (url) {
    return new IORedis(url, { maxRetriesPerRequest: null })
  }
  const host = String(process.env.REDIS_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const port = Math.max(1, parseInt(String(process.env.REDIS_PORT || '6379'), 10) || 6379)
  return new IORedis({
    host,
    port,
    maxRetriesPerRequest: null,
  })
}
