/**
 * Vercel serverless entry for Express.
 * Receipt routes stay lazy-loaded from `app.js` so auth/health avoid heavy receipt deps.
 */
import app from '../src/app.js'

/** Inngest invokes this function for long-running steps (requires Vercel plan limit ≥ 300s). */
export const maxDuration = 300

export default app
