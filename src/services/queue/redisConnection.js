import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Lazy-load so Vercel serverless (queue off) never resolves `ioredis` at cold start. */
let IORedisCtor = null
function getIORedis() {
  if (!IORedisCtor) {
    const mod = require('ioredis')
    IORedisCtor = mod?.default ?? mod
  }
  return IORedisCtor
}

let warnedMissingRedisUrl = false

/**
 * BullMQ needs a **separate** TCP connection for the Queue vs the Worker (blocking
 * commands). Do not share one `IORedis` instance between them — call this factory
 * once per BullMQ class, as we already do in `receiptQueue.js` and `receiptWorker.js`.
 *
 * **Upstash (pick one):**
 * - `REDIS_URL=rediss://default:PASSWORD@endpoint:6379` (password must be URL-encoded if it has `@ : #` etc.)
 * - **Or** unset `REDIS_URL` and set `UPSTASH_REDIS_HOST` + `UPSTASH_REDIS_PASSWORD` (from Upstash “Connect”)
 *   — avoids `WRONGPASS` from broken URL parsing.
 * @see https://docs.bullmq.io/guide/connections
 */

function buildUrlConnectionOptions() {
  const url = String(process.env.REDIS_URL || '').trim()
  if (!url) return null
  const isTlsUrl = /^rediss:/i.test(url)
  return {
    url,
    options: {
      maxRetriesPerRequest: null,
      connectTimeout: 10_000,
      enableReadyCheck: false,
      ...(isTlsUrl ? { tls: { rejectUnauthorized: false } } : {}),
    },
  }
}

/**
 * TCP + password without putting the secret inside a URL (fixes many WRONGPASS cases).
 */
function buildDiscreteRemoteOptions() {
  const password = String(
    process.env.UPSTASH_REDIS_PASSWORD ||
      process.env.REDIS_PASSWORD ||
      '',
  ).trim()
  const host = String(
    process.env.UPSTASH_REDIS_HOST ||
      process.env.REDIS_ENDPOINT ||
      process.env.REDIS_HOST ||
      '',
  ).trim()
  if (!password || !host) return null
  if (host === '127.0.0.1' || host === 'localhost') return null

  const port = Math.max(
    1,
    parseInt(
      String(process.env.UPSTASH_REDIS_PORT || process.env.REDIS_PORT || '6379'),
      10,
    ) || 6379,
  )
  const username = String(
    process.env.REDIS_USERNAME ||
      process.env.UPSTASH_REDIS_USER ||
      'default',
  ).trim()
  const tlsFlag = String(process.env.REDIS_TLS || '').trim().toLowerCase()
  const useTls =
    host.includes('upstash.io') ||
    ['1', 'true', 'yes'].includes(tlsFlag)

  return {
    options: {
      host,
      port,
      username: username || 'default',
      password,
      maxRetriesPerRequest: null,
      connectTimeout: 10_000,
      enableReadyCheck: false,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
    },
  }
}

function buildLocalHostOptions() {
  const host =
    String(process.env.REDIS_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const port = Math.max(
    1,
    parseInt(String(process.env.REDIS_PORT || '6379'), 10) || 6379,
  )
  return {
    options: {
      host,
      port,
      maxRetriesPerRequest: null,
      connectTimeout: 10_000,
      enableReadyCheck: false,
    },
  }
}

/** Log host:port only (never password) — use to confirm Upstash vs local. */
function logRedisEndpointFromUrl(role, url) {
  try {
    const normalized = url
      .replace(/^rediss:/i, 'https:')
      .replace(/^redis:/i, 'http:')
    const u = new URL(normalized)
    const port = u.port || '6379'
    console.log(
      `[redis:${role}] endpoint ${u.hostname}:${port} (user=${u.username || 'none'})`,
    )
  } catch {
    console.warn(`[redis:${role}] could not parse REDIS_URL for logging`)
  }
}

function logRedisEndpointDiscrete(role, opts) {
  const tls = Boolean(opts.tls)
  console.log(
    `[redis:${role}] endpoint ${opts.host}:${opts.port} (user=${opts.username}, tls=${tls})`,
  )
}

function attachRedisLifecycleLog(redis, role) {
  const tag = `[redis:${role}]`
  redis.on('error', (err) => {
    console.error(`${tag} connection error:`, err?.message || err)
    const msg = err instanceof Error ? err.message : String(err || '')
    if (msg.includes('WRONGPASS')) {
      console.error(
        `${tag} WRONGPASS: bad credentials. Fix REDIS_URL (re-copy from Upstash Redis, not REST), or unset REDIS_URL and use UPSTASH_REDIS_HOST + UPSTASH_REDIS_PASSWORD. If the password has @ : # encode it in the URL or use the discrete env vars.`,
      )
    }
  })
  redis.on('connect', () => {
    console.log(`${tag} connected`)
  })
}

/**
 * New Redis connection for BullMQ (one Queue or one Worker each).
 * @param {'queue' | 'worker'} [role] — labels `connect` / `error` logs for Upstash debugging
 */
export function createBullmqRedisConnection(role = 'bullmq') {
  const IORedis = getIORedis()
  const urlCfg = buildUrlConnectionOptions()
  let redis

  if (urlCfg) {
    logRedisEndpointFromUrl(role, urlCfg.url)
    redis = new IORedis(urlCfg.url, urlCfg.options)
  } else {
    const discrete = buildDiscreteRemoteOptions()
    if (discrete) {
      logRedisEndpointDiscrete(role, discrete.options)
      redis = new IORedis(discrete.options)
    } else {
      if (!warnedMissingRedisUrl && !String(process.env.REDIS_URL || '').trim()) {
        warnedMissingRedisUrl = true
        console.warn(
          '[redis] No REDIS_URL — using local REDIS_HOST / REDIS_PORT (set REDIS_URL or UPSTASH_REDIS_HOST + UPSTASH_REDIS_PASSWORD for Upstash).',
        )
      }
      const local = buildLocalHostOptions()
      redis = new IORedis(local.options)
    }
  }
  attachRedisLifecycleLog(redis, role)
  return redis
}

export default createBullmqRedisConnection
