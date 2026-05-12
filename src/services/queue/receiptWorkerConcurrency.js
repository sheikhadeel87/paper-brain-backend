/**
 * BullMQ `Worker` concurrency: how many jobs this process may run in parallel.
 * Per-user Redis lock in `receiptWorker.js` still allows **at most one in-flight job per user**;
 * raise this (e.g. 4–8) so **different users** can each process one receipt at the same time.
 * Default `1` preserves the previous “one job total per worker process” behavior.
 */
export function getReceiptWorkerConcurrency() {
  const raw = parseInt(String(process.env.RECEIPT_WORKER_CONCURRENCY ?? '1'), 10)
  if (!Number.isFinite(raw)) return 1
  return Math.min(Math.max(raw, 1), 32)
}
