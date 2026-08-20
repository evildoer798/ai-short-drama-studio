import { UnrecoverableError, Worker } from 'bullmq'
import { TaskStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { isDeterministicTextApiFailure } from '@/lib/text-task-recovery'
import {
  IMAGE_QUEUE_NAME,
  CANVAS_VIDEO_QUEUE_NAME,
  CANVAS_IMAGE_QUEUE_NAME,
  CANVAS_AUDIO_QUEUE_NAME,
  DIRECTOR_STAGE_QUEUE_NAME,
  DIRECTOR_VIDEO_QUEUE_NAME,
  DIRECTOR_IMAGE_QUEUE_NAME,
  TEXT_QUEUE_NAME,
  VIDEO_QUEUE_NAME,
  getRedisConnectionOptions,
} from '@/lib/queue'
import { processImageGenerationTask } from './image-generation'
import { processVideoGenerationTask } from './video-generation'
import { processTextGenerationTask } from './text-generation'
import { processCanvasVideoTask } from './canvas-video-generation'
import { processCanvasImageTask } from './canvas-image-generation'
import { processCanvasAudioTask } from './canvas-audio-generation'
import { processDirectorStageVersion } from '@/lib/director-generation'
import { processDirectorVideoTask } from './director-video-generation'
import { processDirectorImageTask } from './director-image-generation'
import { processDirectorStateImageTask } from './director-state-image-generation'
import { runWithTextBillingContext } from '@/lib/billing-context'

const textWorker = new Worker(
  TEXT_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('Worker job missing taskId')
    }
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    const willRetryOnFailure = job.attemptsMade + 1 < attempts
    try {
      const owner = await prisma.generationTask.findUnique({
        where: { id: taskId },
        select: { createdById: true },
      })
      if (!owner) throw new Error(`Text task not found: ${taskId}`)
      return await runWithTextBillingContext(
        { taskId, userId: owner.createdById },
        () => processTextGenerationTask(taskId, { willRetryOnFailure }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isDeterministicTextApiFailure(message)) throw error

      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.failed,
          completedAt: new Date(),
          error: message,
        },
      })
      throw new UnrecoverableError(message)
    }
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
    concurrency: Number(process.env.VIDEO_WORKER_CONCURRENCY || 1),
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

const canvasVideoWorker = new Worker(
  CANVAS_VIDEO_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) throw new Error('Canvas video job missing taskId')
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    const willRetryOnFailure = job.attemptsMade + 1 < attempts
    return processCanvasVideoTask(taskId, { willRetryOnFailure })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: Number(process.env.CANVAS_VIDEO_WORKER_CONCURRENCY || 1),
    lockDuration: 60_000,
    maxStalledCount: 5,
  },
)

canvasVideoWorker.on('completed', (job) => {
  console.log(`canvas video task completed: ${job.id}`)
})

canvasVideoWorker.on('failed', (job, error) => {
  console.error(`canvas video task failed: ${job?.id}`, error)
})

const canvasImageWorker = new Worker(
  CANVAS_IMAGE_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) throw new Error('Canvas image job missing taskId')
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    return processCanvasImageTask(taskId, { willRetryOnFailure: job.attemptsMade + 1 < attempts })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 1,
    limiter: { max: 1, duration: Number(process.env.IMAGE_WORKER_RATE_LIMIT_MS || 15_000) },
    lockDuration: 10 * 60_000,
    maxStalledCount: 3,
  },
)

canvasImageWorker.on('completed', (job) => console.log(`canvas image task completed: ${job.id}`))
canvasImageWorker.on('failed', (job, error) => console.error(`canvas image task failed: ${job?.id}`, error))

const canvasAudioWorker = new Worker(
  CANVAS_AUDIO_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) throw new Error('Canvas audio job missing taskId')
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    return processCanvasAudioTask(taskId, { willRetryOnFailure: job.attemptsMade + 1 < attempts })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 1,
    lockDuration: 10 * 60_000,
    maxStalledCount: 3,
  },
)

canvasAudioWorker.on('completed', (job) => console.log(`canvas audio task completed: ${job.id}`))
canvasAudioWorker.on('failed', (job, error) => console.error(`canvas audio task failed: ${job?.id}`, error))

const directorStageWorker = new Worker(
  DIRECTOR_STAGE_QUEUE_NAME,
  async (job) => {
    const stageVersionId = job.data?.stageVersionId
    if (typeof stageVersionId !== 'string' || !stageVersionId) throw new Error('Director stage job missing stageVersionId')
    return processDirectorStageVersion(stageVersionId)
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 1,
    lockDuration: 10 * 60_000,
    maxStalledCount: 3,
  },
)

directorStageWorker.on('completed', (job) => console.log(`director stage completed: ${job.id}`))
directorStageWorker.on('failed', (job, error) => console.error(`director stage failed: ${job?.id}`, error))

const directorVideoWorker = new Worker(
  DIRECTOR_VIDEO_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) throw new Error('Director video job missing taskId')
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    return processDirectorVideoTask(taskId, { willRetryOnFailure: job.attemptsMade + 1 < attempts })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: Number(process.env.DIRECTOR_VIDEO_WORKER_CONCURRENCY || 1),
    lockDuration: 60_000,
    maxStalledCount: 5,
  },
)

directorVideoWorker.on('completed', (job) => console.log(`director video completed: ${job.id}`))
directorVideoWorker.on('failed', (job, error) => console.error(`director video failed: ${job?.id}`, error))

const directorImageWorker = new Worker(
  DIRECTOR_IMAGE_QUEUE_NAME,
  async (job) => {
    const taskId = job.data?.taskId
    if (typeof taskId !== 'string' || !taskId) throw new Error('Director image job missing taskId')
    const attempts = Math.max(1, Number(job.opts.attempts || 1))
    return job.data?.kind === 'character-state'
      ? processDirectorStateImageTask(taskId, { willRetryOnFailure: job.attemptsMade + 1 < attempts })
      : processDirectorImageTask(taskId, { willRetryOnFailure: job.attemptsMade + 1 < attempts })
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 1,
    limiter: { max: 1, duration: Number(process.env.IMAGE_WORKER_RATE_LIMIT_MS || 15_000) },
    lockDuration: 10 * 60_000,
    maxStalledCount: 3,
  },
)

directorImageWorker.on('completed', (job) => console.log(`director image completed: ${job.id}`))
directorImageWorker.on('failed', (job, error) => console.error(`director image failed: ${job?.id}`, error))

console.log(`Workers listening on ${TEXT_QUEUE_NAME}, ${IMAGE_QUEUE_NAME}, ${VIDEO_QUEUE_NAME}, ${CANVAS_IMAGE_QUEUE_NAME}, ${CANVAS_VIDEO_QUEUE_NAME}, ${CANVAS_AUDIO_QUEUE_NAME}, ${DIRECTOR_STAGE_QUEUE_NAME}, ${DIRECTOR_IMAGE_QUEUE_NAME}, and ${DIRECTOR_VIDEO_QUEUE_NAME}`)
