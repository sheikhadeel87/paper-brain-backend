import { createBullmqRedisConnection } from './redisConnection.js'
import { receiptQueue } from './receiptQueue.js'

const QUEUE_NAME = 'receipt-processing'

const DEFAULT_QUEUE_JOB_OPTS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 10000,
  },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 200 },
}

let flowProducer = null

async function getFlowProducer() {
  if (flowProducer) return flowProducer
  const { FlowProducer } = await import('bullmq')
  flowProducer = new FlowProducer({
    connection: createBullmqRedisConnection('flow'),
  })
  return flowProducer
}

/**
 * Nested flow: leaf runs first, then each parent — strict FIFO for one upload batch
 * even with many BullMQ workers (no Redis mutex required for intra-batch order).
 * @param {{ name: string, data: object }[]} jobs same shape as `Queue.addBulk`
 * @returns {Promise<string[]>} job ids in **upload order** (first file → last file)
 */
export async function enqueueReceiptUploadJobs(jobs) {
  if (jobs.length === 0) return []
  if (!receiptQueue) return []
  if (jobs.length === 1) {
    const [q] = await receiptQueue.addBulk(jobs)
    return [String(q.id)]
  }

  const fp = await getFlowProducer()

  function nodeAt(i) {
    const j = jobs[i]
    const base = {
      name: j.name,
      queueName: QUEUE_NAME,
      data: j.data,
    }
    if (i === 0) return base
    return {
      name: j.name,
      queueName: QUEUE_NAME,
      data: j.data,
      children: [nodeAt(i - 1)],
    }
  }

  const tree = await fp.add(nodeAt(jobs.length - 1), {
    queuesOptions: {
      [QUEUE_NAME]: { defaultJobOptions: DEFAULT_QUEUE_JOB_OPTS },
    },
  })

  return collectJobIdsUploadOrder(tree)
}

function collectJobIdsUploadOrder(tree) {
  if (!tree?.children?.length) return [String(tree.job.id)]
  return [
    ...collectJobIdsUploadOrder(tree.children[0]),
    String(tree.job.id),
  ]
}
