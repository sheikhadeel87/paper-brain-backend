/**
 * Minimum wall time between finishing one receipt job and starting the next (queue worker,
 * inline `/upload-multiple`, and Inngest `receipt/uploaded` runs per user).
 * Set `RECEIPT_QUEUE_MIN_SLOT_MS=0` to disable spacing (e.g. local dev).
 */
export function receiptQueueMinSlotMs() {
  return Math.max(
    0,
    parseInt(
      String(
        process.env.RECEIPT_QUEUE_MIN_SLOT_MS ??
          process.env.RECEIPT_QUEUE_INTER_JOB_DELAY_MS ??
          '60000',
      ),
      10,
    ) || 0,
  );
}
