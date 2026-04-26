/**
 * Fail fast in production when secrets are missing (Atlas + Vercel-style deploy).
 */
export function validateProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;

  const required = ['MONGO_URI', 'JWT_SECRET', 'GEMINI_API_KEY'];
  const missing = required.filter((k) => !String(process.env[k] || '').trim());
  if (missing.length === 0) return;

  console.error(
    `[env] Production requires: ${missing.join(', ')}. Set them on your host (e.g. Railway/Render/Fly), not only in a local .env file.`,
  );
  process.exit(1);
}
