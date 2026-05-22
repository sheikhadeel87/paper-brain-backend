import { connectMongo } from '../../lib/mongoConnect.js';
import { receiptQueueMinSlotMs } from '../../lib/receiptQueueSlotMs.js';
import { ReceiptUploadJob } from '../../models/ReceiptUploadJob.js';
import { inngest } from '../client.js';

function logErrorStack(label, err) {
  console.error(label, err?.stack || err?.message || err);
}

/**
 * **Per-user** concurrency: FIFO (one-at-a-time) `receipt/uploaded` runs per `userId`;
 * different users do not block each other. Receipt rows are created in the final persist
 * step (not at HTTP upload time), so “Recent receipts” `createdAt` reflects true completion order.
 */
export const processReceiptWorkflow = inngest.createFunction(
  {
    id: 'process-receipt-workflow',
    name: 'Process receipt (Gemini)',
    triggers: [{ event: 'receipt/uploaded' }],
    concurrency: { limit: 1, key: 'event.data.userId' },
    onFailure: async ({ event, error }) => {
      try {
        logErrorStack('[inngest:receipt] workflow failed:', error);
        await connectMongo();
        const nested = event?.data?.event;
        const d = nested && typeof nested === 'object' ? nested.data : null;
        const jobId = d?.jobId;
        const userId = d?.userId;
        if (jobId && userId) {
          const { markReceiptUploadJobFailed } = await import('../../routes/receipt.js');
          await markReceiptUploadJobFailed(String(userId), String(jobId), error?.message);
          console.log('[inngest:receipt] marked upload job failed', {
            jobId: String(jobId),
            userId: String(userId),
          });
        }
      } catch (e) {
        logErrorStack('[receipt] processReceiptWorkflow onFailure:', e);
      }
    },
  },
  async ({ event, step }) => {
    const { jobId, imageUrl, userId, cloudinaryPublicId } = event.data || {};
    console.log('[inngest:receipt] receipt/uploaded received', {
      jobId: jobId ? String(jobId) : '',
      userId: userId ? String(userId) : '',
      hasImageUrl: Boolean(imageUrl),
      cloudinaryPublicId: cloudinaryPublicId || '',
    });
    if (!jobId || !imageUrl || !userId) {
      console.warn('[inngest:receipt] receipt/uploaded ignored — incomplete payload', {
        hasJobId: Boolean(jobId),
        hasImageUrl: Boolean(imageUrl),
        hasUserId: Boolean(userId),
      });
      return { skipped: true, reason: 'incomplete_payload' };
    }
    const pub = typeof cloudinaryPublicId === 'string' ? cloudinaryPublicId : '';

    const gemini = await step.run('gemini-parse', async () => {
      console.log('[inngest:receipt] gemini-parse step started', {
        jobId: String(jobId),
        userId: String(userId),
      });
      await connectMongo();
      const mongoose = (await import('mongoose')).default;
      const updateResult = await ReceiptUploadJob.updateOne(
        {
          jobId: String(jobId),
          user: new mongoose.Types.ObjectId(String(userId)),
        },
        { $set: { status: 'processing' } },
      );
      console.log('[inngest:receipt] upload job marked processing', {
        jobId: String(jobId),
        matchedCount: updateResult.matchedCount,
        modifiedCount: updateResult.modifiedCount,
      });
      const { parseReceiptWithGeminiFromUrl } = await import('../../routes/receipt.js');
      const result = await parseReceiptWithGeminiFromUrl('', String(imageUrl));
      console.log('[inngest:receipt] gemini-parse step finished', {
        jobId: String(jobId),
        ok: Boolean(result?.ok),
        receiptCount: Array.isArray(result?.receipts) ? result.receipts.length : 0,
        code: result?.code || '',
        error: result?.error || '',
      });
      return result;
    });

    await step.run('persist-mongodb', async () => {
      console.log('[inngest:receipt] persist-mongodb step started', {
        jobId: String(jobId),
        userId: String(userId),
      });
      await connectMongo();
      const { persistAsyncReceiptUploadJob } = await import('../../routes/receipt.js');
      const result = await persistAsyncReceiptUploadJob(String(jobId), String(userId), gemini, {
        imageUrl,
        cloudinaryPublicId: pub,
      });
      console.log('[inngest:receipt] persist-mongodb step finished', {
        jobId: String(jobId),
        ok: Boolean(result?.ok),
        receiptIds: result?.receiptIds || [],
        code: result?.code || '',
      });
      return result;
    });

    const slotMs = receiptQueueMinSlotMs();
    if (slotMs > 0) {
      await step.sleep('inter-receipt-min-slot', slotMs);
    }

    return { ok: true, jobId: String(jobId) };
  },
);
