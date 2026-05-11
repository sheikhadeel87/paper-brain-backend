/**
 * Vercel serverless entry for Express.
 * Importing `app` from `src/app.js` ensures dependency tracing includes `multer`
 * and the rest of the route tree from this project root (where `package.json` lives).
 */
import app from '../src/app.js'

export default app
