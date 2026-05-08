import { getGeminiApiKeys } from './geminiApiKeyPool.js'

/**
 * Fail fast in production when secrets are missing (Atlas + Vercel-style deploy).
 */
export function validateProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;

  const missing = ['MONGO_URI', 'JWT_SECRET'].filter(
    (k) => !String(process.env[k] || '').trim(),
  );
  if (getGeminiApiKeys().length === 0) {
    missing.push('GEMINI_API_KEY or GEMINI_API_KEYS');
  }
  if (missing.length === 0) return;

  console.error(
    `[env] Production requires: ${missing.join(', ')}. Set them on your host (e.g. Railway/Render/Fly), not only in a local .env file.`,
  );
  process.exit(1);
}
