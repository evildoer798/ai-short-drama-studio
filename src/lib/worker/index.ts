import { Worker } from 'bullmq'
import { TaskStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  IMAGE_QUEUE_NAME,
  TEXT_QUEUE_NAME,
  VIDEO_QUEUE_NAME,
  getRedisConnectionOptions,
} from '@/lib/queue'
import { processImageGenerationTask } from './image-generation'
import { processVideoGenerationTask } from './video-generation'
import { processTextGenerationTask } from './text-generation'

const textWorker = new Worker(
  TEXT_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('Worker job missing taskId')
    }
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    const willRetryOnFailure = job.attemptsMade + 1 < attempts
    return processTextGenerationTask(taskId, { willRetryOnFailure })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: Number(process.env.TEXT_WORKER_CONCURRENCY || 1),
    lockDuration: 3 * 60_000,
    maxStalledCount: 5,
  },
)

textWorker.on('completed', (job) => {
  console.log(`text task completed: ${job.id}`)
})

textWorker.on('failed', async (job, error) => {
  console.error(`text task failed: ${job?.id}`, error)
  const taskId = job?.data?.taskId
  if (typeof taskId !== 'string' || !taskId) return
  const attempts = Math.max(1, Number(job?.opts.attempts || 1))
  if (job && job.attemptsMade < attempts) return
  try {
    const task = await prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    })
    if (task?.status === TaskStatus.queued || task?.status === TaskStatus.processing) {
      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.failed,
          completedAt: new Date(),
          error: 'TEXT_WORKER_INTERRUPTED: 后台文字任务意外中断，检查点已保留，请重新点击继续。',
        },
      })
    }
  } catch (updateError) {
    console.error(`failed to update text task state: ${taskId}`, updateError)
  }
})

const imageWorker = new Worker(
  IMAGE_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('Worker job missing taskId')
    }
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    const willRetryOnFailure = job.attemptsMade + 1 < attempts
    return processImageGenerationTask(taskId, { willRetryOnFailure })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: Number(process.env.IMAGE_WORKER_CONCURRENCY || 1),
    limiter: {
      max: 1,
      duration: Number(process.env.IMAGE_WORKER_RATE_LIMIT_MS || 15_000),
    },
    lockDuration: 10 * 60_000,
    maxStalledCount: 5,
  },
)

imageWorker.on('completed', (job) => {
  console.log(`image task completed: ${job.id}`)
})

imageWorker.on('failed', async (job, error) => {
  console.error(`image task failed: ${job?.id}`, error)
  const taskId = job?.data?.taskId
  if (typeof taskId !== 'string' || !taskId) return
  const attempts = Math.max(1, Number(job?.opts.attempts || 1))
  if (job && job.attemptsMade < attempts) return
  try {
    const task = await prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    })
    if (task?.status === TaskStatus.queued || task?.status === TaskStatus.processing) {
      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.failed,
          completedAt: new Date(),
          error: '后台生图任务意外中断，请重新点击生成。',
        },
      })
    }
  } catch (updateError) {
    console.error(`failed to update image task state: ${taskId}`, updateError)
  }
})

const videoWorker = new Worker(
  VIDEO_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('Worker job missing taskId')
    }
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    const willRetryOnFailure = job.attemptsMade + 1 < attempts
    return processVideoGenerationTask(taskId, { willRetryOnFailure })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 1,
    lockDuration: 60_000,
    maxStalledCount: 5,
  },
)

videoWorker.on('completed', (job) => {
  console.log(`video task completed: ${job.id}`)
})

videoWorker.on('failed', (job, error) => {
  console.error(`video task failed: ${job?.id}`, error)
})

console.log(`Workers listening on ${TEXT_QUEUE_NAME}, ${IMAGE_QUEUE_NAME}, and ${VIDEO_QUEUE_NAME}`)
