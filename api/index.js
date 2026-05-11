/**
 * Vercel serverless entry for Express.
 * Receipt routes are lazy-loaded from `app.js` so auth/health cold starts avoid sharp/native deps.
 */
import app from '../src/app.js'

export default app
