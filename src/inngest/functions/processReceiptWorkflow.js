import { connectMongo } from '../../lib/mongoConnect.js';
import { receiptQueueMinSlotMs } from '../../lib/receiptQueueSlotMs.js';
import { ReceiptUploadJob } from '../../models/ReceiptUploadJob.js';
import { inngest } from '../client.js';

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
        await connectMongo();
        const nested = event?.data?.event;
        const d = nested && typeof nested === 'object' ? nested.data : null;
        const jobId = d?.jobId;
        const userId = d?.userId;
        if (jobId && userId) {
          const { markReceiptUploadJobFailed } = await import('../../routes/receipt.js');
          await markReceiptUploadJobFailed(String(userId), String(jobId), error?.message);
        }
      } catch (e) {
        console.error('[receipt] processReceiptWorkflow onFailure:', e);
      }
    },
  },
  async ({ event, step }) => {
    const { jobId, imageUrl, userId, cloudinaryPublicId } = event.data;
    if (!jobId || !imageUrl || !userId) {
      throw new Error('receipt/uploaded missing jobId, imageUrl, or userId');
    }
    const pub = typeof cloudinaryPublicId === 'string' ? cloudinaryPublicId : '';

    const gemini = await step.run('gemini-parse', async () => {
      await connectMongo();
      const mongoose = (await import('mongoose')).default;
      await ReceiptUploadJob.updateOne(
        {
          jobId: String(jobId),
          user: new mongoose.Types.ObjectId(String(userId)),
        },
        { $set: { status: 'processing' } },
      );
      const { parseReceiptWithGeminiFromUrl } = await import('../../routes/receipt.js');
      return parseReceiptWithGeminiFromUrl('', String(imageUrl));
    });

    await step.run('persist-mongodb', async () => {
      await connectMongo();
      const { persistAsyncReceiptUploadJob } = await import('../../routes/receipt.js');
      return persistAsyncReceiptUploadJob(String(jobId), String(userId), gemini, {
        imageUrl,
        cloudinaryPublicId: pub,
      });
    });

    const slotMs = receiptQueueMinSlotMs();
    if (slotMs > 0) {
      await step.sleep('inter-receipt-min-slot', slotMs);
    }

    return { ok: true, jobId: String(jobId) };
  },
);
