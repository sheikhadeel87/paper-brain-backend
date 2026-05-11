/**
 * Rotating pool of Gemini API keys (comma-separated GEMINI_API_KEY or GEMINI_API_KEYS).
 * Global index advances on quota/429 so the same exhausted key is not reused immediately.
 * API Key Rotation or Failover Strategy.
 */

let geminiKeyIndex = 0

function splitKeyEnv(value) {
  if (!value || typeof value !== 'string') return []
  return value
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((k) => k.length >= 8)
}

/**
 * @returns {string[]} non-empty API keys (AIza…)
 */
export function getGeminiApiKeys() {
  const fromMulti = splitKeyEnv(process.env.GEMINI_API_KEYS || '')
  if (fromMulti.length > 0) return fromMulti
  return splitKeyEnv(process.env.GEMINI_API_KEY || '')
}

export function geminiKeyPoolSize() {
  return getGeminiApiKeys().length
}

/** Index used for the last started attempt (0-based, modulo pool size). */
export function peekGeminiKeyIndex(keysLength) {
  if (keysLength < 1) return 0
  return geminiKeyIndex % keysLength
}

export function isGeminiQuotaLikeError(err) {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase()
  if (!msg) return false
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('exhausted')
  )
}

/** After quota/429 on current key — move global cursor to next key. */
export function advanceGeminiKeyIndexAfterQuota(keysLength) {
  if (keysLength < 2) return
  geminiKeyIndex = (geminiKeyIndex + 1) % keysLength
}

/** After a successful Gemini call — round-robin for the next job. */
export function advanceGeminiKeyIndexAfterSuccess(keysLength, usedKeyIndex) {
  if (keysLength < 1) return
  geminiKeyIndex = (usedKeyIndex + 1) % keysLength
}

export function logGeminiKeyPool(contextLabel) {
  const n = geminiKeyPoolSize()
  if (n === 0) {
    console.warn(
      `[${contextLabel}] Gemini key pool: empty (set GEMINI_API_KEY or GEMINI_API_KEYS)`,
    )
    return
  }
  console.log(
    `[${contextLabel}] Gemini key pool: ${n} key(s), starting index ${peekGeminiKeyIndex(n)}`,
  )
}
