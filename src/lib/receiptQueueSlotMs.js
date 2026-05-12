/**
 * Minimum wall time between **Mongo receipt persists** for the same user (per-user Redis
 * throttle in `receiptUserPersistThrottle.js`, applied **before** each job’s Gemini + draft
 * insert). Queue worker, inline `/upload-multiple`, etc.
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
