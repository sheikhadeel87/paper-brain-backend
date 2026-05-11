import { isCloudinaryConfigured } from '../services/cloudinaryUpload.js';

/** Cloudinary + Inngest event key: enables 202 async receipt processing. */
export function receiptAsyncPipelineEnabled() {
  return (
    isCloudinaryConfigured() && Boolean(String(process.env.INNGEST_EVENT_KEY || '').trim())
  );
}
