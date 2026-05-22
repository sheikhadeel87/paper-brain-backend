import './bootEnv.js'
import express from 'express'
import cors from 'cors'
import { connectMongo } from './lib/mongoConnect.js'
import authRoutes from './routes/auth.js'
import expenseRoutes from './routes/expenses.js'
import stripeRoutes from './routes/stripe.js'
import whatsappRoutes from './routes/whatsapp.js'
import { serve } from 'inngest/express'
import { inngest } from './inngest/client.js'
import { processReceiptWorkflow } from './inngest/functions/processReceiptWorkflow.js'

/**
 * Receipt routes import multer, Gemini, queue, etc. Lazy-load so Vercel cold starts
 * for /api/auth/* and /api/expenses/* avoid pulling the full receipt stack.
 */
let receiptRouterCache = null
let receiptRouterLoading = null
async function getReceiptRouter() {
  if (receiptRouterCache) return receiptRouterCache
  if (!receiptRouterLoading) {
    receiptRouterLoading = import('./routes/receipt.js').then((m) => m.default)
  }
  receiptRouterCache = await receiptRouterLoading
  return receiptRouterCache
}

function mountReceiptLazy(req, res, next) {
  getReceiptRouter()
    .then((router) => router(req, res, next))
    .catch(next)
}

const app = express()

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Always allow these (Vercel alpha + Vite dev). */
const builtInAllowList = new Set([
  'https://paper-brain-alpha.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://localhost:5173',
  'https://127.0.0.1:5173',
])

function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true)
  if (allowedOrigins.includes('*')) return cb(null, true)
  if (builtInAllowList.has(origin)) return cb(null, true)
  if (allowedOrigins.includes(origin)) return cb(null, true)
  try {
    const { hostname } = new URL(origin)
    if (hostname.endsWith('.vercel.app')) return cb(null, true)
  } catch {
    return cb(null, false)
  }
  return cb(null, false)
}

const corsOptions = {
  credentials: true,
  exposedHeaders: ['X-Process-Time-Ms'],
  origin: corsOrigin,
}

// --- Middleware order: logging → OPTIONS (Express 5-safe) → cors → body parser → routes
app.use((req, res, next) => {
  console.log(`[${req.method}] Origin: ${req.headers.origin ?? '(none)'}`)
  next()
})

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return cors(corsOptions)(req, res, next)
  }
  next()
})

app.use(cors(corsOptions))
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ status: 'OK' })
})

// Canonical WhatsApp webhook: /api/whatsapp/webhook (no DB connection needed).
console.log('[whatsapp:webhook] canonical endpoint: /api/whatsapp/webhook')
app.use('/api/whatsapp', whatsappRoutes)

// Vercel serverless: `server.js` is not the entry, so this runs Mongo before /api.
app.use('/api', async (req, res, next) => {
  try {
    await connectMongo()
    next()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[mongo] connect failed:', msg)
    if (String(process.env.MONGO_URI || '').includes('mongodb+srv')) {
      console.error(
        'Atlas: Network Access, URL-encoded password in MONGO_URI, and cluster host must be correct.',
      )
    }
    return res.status(503).json({
      success: false,
      error:
        'Database connection failed. Verify MONGO_URI and Atlas allowlist, then try again.',
    })
  }
})

app.use('/api/auth', authRoutes)
app.use('/api/stripe', stripeRoutes)
app.use(
  '/api/inngest',
  serve({ client: inngest, functions: [processReceiptWorkflow] }),
)
app.use('/api/receipt', mountReceiptLazy)
app.use('/api/expenses', expenseRoutes)

// Vercel returns HTML "Internal Server Error" if nothing converts thrown errors to JSON
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err)
  }
  const status = err.status || err.statusCode || 500
  const message = err instanceof Error ? err.message : 'Server error'
  if (message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, error: 'Origin not allowed.' })
  }
  console.error('[app]', err)
  return res.status(status).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Server error.' : message,
  })
})

export default app
