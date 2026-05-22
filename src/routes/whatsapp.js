import express from 'express'
import axios from 'axios'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import { connectMongo } from '../lib/mongoConnect.js'
import { User } from '../models/User.js'
import { ReceiptUploadJob } from '../models/ReceiptUploadJob.js'
import { uploadReceiptImageBuffer } from '../services/cloudinaryUpload.js'
import { inngest } from '../inngest/client.js'

const router = express.Router()
const TEMP_WHATSAPP_VERIFY_TOKENS = ['paper_b', 'paper_brain_secret_token_123']

/**
 * WhatsApp receipt upload webhook.
 *
 * Meta sends image messages here. We download the media, upload it to Cloudinary,
 * create the same async upload job used by receipt uploads, then trigger Inngest
 * so the existing Gemini + persistence pipeline can process the receipt.
 */

function logErrorStack(label, err) {
  console.error(label, err?.stack || err?.message || err)
}

function logAxiosError(label, err) {
  const response = err?.response
  console.error(label, {
    message: err?.message || String(err),
    status: response?.status || null,
    statusText: response?.statusText || '',
    data: response?.data || null,
  })
  if (err?.stack) console.error(`${label} stack:`, err.stack)
}

function backendEnvVerifyToken() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const envPath = path.join(currentDir, '..', '..', '.env')
  try {
    const line = fs
      .readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*WHATSAPP_VERIFY_TOKEN\s*=/.test(l))
    if (!line) return ''
    return line
      .replace(/^\s*WHATSAPP_VERIFY_TOKEN\s*=\s*/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '')
  } catch {
    return ''
  }
}

function verifyToken() {
  return String(backendEnvVerifyToken() || process.env.WHATSAPP_VERIFY_TOKEN || '').trim()
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d]/g, '')
}

// Resolve WhatsApp sender to a Paper Brain user. In local/testing, fall back to
// WHATSAPP_SANDBOX_USER_ID so receipt processing can reuse the normal pipeline.
async function resolveUserIdFromPhone(phone) {
  const normalized = normalizePhone(phone)
  if (normalized) {
    const user = await User.collection.findOne(
      {
        $or: [
          { phone: normalized },
          { phoneNumber: normalized },
          { whatsappPhone: normalized },
          { whatsappNumber: normalized },
          { 'profile.phone': normalized },
        ],
      },
      { projection: { _id: 1 } },
    )

    if (user?._id) {
      console.log('[whatsapp:user] matched sender to user')
      return user._id.toString()
    }
  }

  const fallbackId = String(
    process.env.WHATSAPP_SANDBOX_USER_ID || process.env.WHATSAPP_TEST_USER_ID || '',
  ).trim()
  if (mongoose.Types.ObjectId.isValid(fallbackId)) {
    console.log('[whatsapp:user] using sandbox fallback user')
    return fallbackId
  }

  throw new Error('No user matched WhatsApp phone and WHATSAPP_SANDBOX_USER_ID is not set')
}

// Meta media download is a two-step flow:
// 1. Fetch media metadata by media ID.
// 2. Fetch the temporary media URL with the same Bearer token.
async function fetchWhatsappImageBuffer(mediaId) {
  const token = String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim()
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')

  const graphVersion = String(process.env.WHATSAPP_GRAPH_VERSION || 'v20.0').trim()
  console.log('[whatsapp:media] fetching media metadata from Graph API')
  let mediaRes
  try {
    mediaRes = await axios.get(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    )
  } catch (err) {
    logAxiosError('[whatsapp:media] metadata request failed', err)
    throw err
  }
  const mediaUrl = mediaRes.data?.url
  console.log('[whatsapp:media] metadata response', {
    status: mediaRes.status,
    hasUrl: Boolean(mediaUrl),
    mimeType: mediaRes.data?.mime_type || '',
  })
  if (!mediaUrl) throw new Error('Meta media URL missing from Graph API response')

  console.log('[whatsapp:media] downloading binary image')
  let imageRes
  try {
    imageRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    })
  } catch (err) {
    logAxiosError('[whatsapp:media] binary image request failed', err)
    throw err
  }

  const buffer = Buffer.from(imageRes.data)
  console.log('[whatsapp:media] image download success', {
    status: imageRes.status,
    contentType: imageRes.headers?.['content-type'] || '',
    bytes: buffer.length,
  })
  return buffer
}

// Turn a WhatsApp image message into a Cloudinary-backed receipt upload job.
async function processWhatsappImageMessage(message) {
  const mediaId = message.image?.id
  console.log('[whatsapp:image] processing started', {
    mediaId: mediaId || '',
  })
  if (!mediaId) {
    console.warn('[whatsapp:webhook] image message missing mediaId')
    return
  }

  await connectMongo()
  const userId = await resolveUserIdFromPhone(message.from)
  const buffer = await fetchWhatsappImageBuffer(String(mediaId))
  console.log('[whatsapp:image] uploading image to Cloudinary', {
    bytes: buffer.length,
  })
  const { url: imageUrl, publicId: cloudinaryPublicId } =
    await uploadReceiptImageBuffer(buffer, {
      userId,
      originalFilename: `whatsapp-${mediaId}.jpg`,
    })
  console.log('[whatsapp:image] Cloudinary upload success')

  const jobObjectId = new mongoose.Types.ObjectId()
  const newJob = await ReceiptUploadJob.create({
    _id: jobObjectId,
    jobId: jobObjectId.toString(),
    user: new mongoose.Types.ObjectId(userId),
    imageUrl,
    cloudinaryPublicId,
    status: 'queued',
  })
  console.log('[whatsapp:image] ReceiptUploadJob created', {
    jobId: newJob.jobId,
    status: newJob.status,
  })

  await inngest.send({
    name: 'receipt/uploaded',
    data: {
      jobId: newJob._id.toString(),
      userId,
      imageUrl,
      cloudinaryPublicId,
    },
  })

  console.log('[whatsapp:image] Inngest event sent; receipt image queued', {
    jobId: newJob._id.toString(),
  })
}

// Handle inbound WhatsApp messages. Text is logged for visibility; image messages
// are forwarded into the receipt upload flow above.
async function processWhatsappMessages(messages) {
  console.log('[whatsapp:webhook] processing parsed messages', {
    count: messages.length,
  })
  for (const message of messages) {
    try {
      const from = message.from
      const type = message.type
      const messageId = message.id

      console.log(
        `[whatsapp:webhook] message received from=${from || '(unknown)'} type=${type || '(unknown)'} id=${messageId || '(missing)'}`,
      )

      if (type === 'text') {
        console.log(`[whatsapp:webhook] text body: ${message.text?.body || ''}`)
      }

      if (type === 'image') {
        const mediaId = message.image?.id
        console.log(`[whatsapp:webhook] image message detected; mediaId=${mediaId || '(missing)'}`)
        await processWhatsappImageMessage(message)
      }
    } catch (err) {
      logErrorStack('[whatsapp:webhook] message processing failed:', err)
    }
  }
}

function processWhatsappStatuses(statuses) {
  if (statuses.length > 0) {
    console.log('[whatsapp:webhook] processing message statuses', {
      count: statuses.length,
    })
  }
  for (const status of statuses) {
    console.log('[whatsapp:webhook] message status received', {
      id: status.id || '',
      recipientId: status.recipient_id || '',
      status: status.status || '',
      timestamp: status.timestamp || '',
      conversationId: status.conversation?.id || '',
      pricingCategory: status.pricing?.category || '',
    })
  }
}

// Meta webhook verification endpoint.
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode']
  const token = String(req.query['hub.verify_token'] || '').trim()
  const challenge = req.query['hub.challenge']

  if (!mode && !token && !challenge) {
    return res.status(200).send('WhatsApp webhook endpoint is live')
  }

  if (
    mode === 'subscribe' &&
    (TEMP_WHATSAPP_VERIFY_TOKENS.includes(token) || token === verifyToken())
  ) {
    return res.status(200).send(String(challenge || ''))
  }

  return res.sendStatus(403)
}

function receiveWebhook(req, res) {
  const changes =
    req.body?.entry?.flatMap((entry) => entry.changes || []) || []
  const fields = changes.map((change) => change.field || '(unknown)')

  console.log('[whatsapp:webhook] POST received', {
    object: req.body?.object || '',
    entries: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
    fields,
  })
  const messages =
    changes.flatMap((change) => change.value?.messages || [])
  const statuses =
    changes.flatMap((change) => change.value?.statuses || [])
  console.log('[whatsapp:webhook] payload parsed', {
    fields,
    messages: messages.length,
    statuses: statuses.length,
    types: messages.map((message) => message.type || '(unknown)'),
    statusTypes: statuses.map((status) => status.status || '(unknown)'),
  })

  if (messages.some((message) => message.type === 'image')) {
    res.sendStatus(200)
    processWhatsappMessages(messages).catch((err) => {
      logErrorStack('[whatsapp:webhook] image ingestion failed:', err)
    })
    processWhatsappStatuses(statuses)
    return
  }

  processWhatsappMessages(messages).catch((err) => {
    logErrorStack('[whatsapp:webhook] message handling failed:', err)
  })
  processWhatsappStatuses(statuses)
  return res.sendStatus(200)
}

router.get('/webhook', verifyWebhook)
router.post('/webhook', receiveWebhook)

export default router
