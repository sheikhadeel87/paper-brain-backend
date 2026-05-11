import { connectMongo } from '../../lib/mongoConnect.js';
import { inngest } from '../client.js';

export const processReceiptWorkflow = inngest.createFunction(
  {
    id: 'process-receipt-workflow',
    name: 'Process receipt (Gemini)',
    triggers: [{ event: 'receipt/uploaded' }],
    concurrency: {
      limit: 1,
      key: 'event.data.userId',
    },
  },
  async ({ event, step }) => {
    const { receiptId, imageUrl, userId } = event.data;
    if (!receiptId || !imageUrl || !userId) {
      throw new Error('receipt/uploaded missing receiptId, imageUrl, or userId');
    }

    await step.run('mark-processing', async () => {
      await connectMongo();
      const { Receipt } = await import('../../models/Receipt.js');
      const mongoose = (await import('mongoose')).default;
      await Receipt.updateOne(
        {
          _id: new mongoose.Types.ObjectId(String(receiptId)),
          user: new mongoose.Types.ObjectId(String(userId)),
        },
        { $set: { processingStatus: 'processing' } },
      );
    });

    const gemini = await step.run('gemini-parse', async () => {
      await connectMongo();
      const { parseReceiptWithGeminiFromUrl } = await import('../../routes/receipt.js');
      return parseReceiptWithGeminiFromUrl('', String(imageUrl));
    });

    await step.run('persist-mongodb', async () => {
      await connectMongo();
      const { finalizePendingReceiptsFromGemini } = await import('../../routes/receipt.js');
      return finalizePendingReceiptsFromGemini(String(receiptId), String(userId), gemini);
    });

    return { ok: true, receiptId: String(receiptId) };
  },
);
