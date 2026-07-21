import { Queue } from 'bullmq'
import { env } from './env'

export const IMAGE_QUEUE_NAME = 'shortdrama-image-generation'
export const TEXT_QUEUE_NAME = 'shortdrama-text-generation'
export const VIDEO_QUEUE_NAME = 'shortdrama-video-generation'
export const RENDER_QUEUE_NAME = 'shortdrama-project-render'

let imageQueue: Queue | null = null
let textQueue: Queue | null = null
let videoQueue: Queue | null = null
let renderQueue: Queue | null = null

export function getRedisConnectionOptions() {
  return {
    host: env.redisHost(),
    port: env.redisPort(),
    password: env.redisPassword() || undefined,
    maxRetriesPerRequest: null,
  }
}

export function getImageQueue() {
  imageQueue ??= new Queue(IMAGE_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 20_000,
      },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  })
  return imageQueue
}

export async function enqueueImageGenerationTask(taskId: string) {
  await getImageQueue().add('generate-image', { taskId }, { jobId: taskId })
}

export function getTextQueue() {
  textQueue ??= new Queue(TEXT_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 15_000,
      },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return textQueue
}

export async function enqueueTextGenerationTask(taskId: string) {
  await getTextQueue().add('generate-preproduction-text', { taskId }, { jobId: taskId })
}

export async function requeueTextGenerationTask(taskId: string) {
  const queue = getTextQueue()
  const existing = await queue.getJob(taskId)
  if (existing) {
    const state = await existing.getState()
    if (['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
      throw new Error('TEXT_TASK_STILL_ACTIVE')
    }
    await existing.remove()
  }
  await queue.add('generate-preproduction-text', { taskId }, { jobId: taskId })
}

export function getVideoQueue() {
  videoQueue ??= new Queue(VIDEO_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30_000,
      },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return videoQueue
}

export async function enqueueVideoGenerationTask(taskId: string) {
  await getVideoQueue().add('generate-video', { taskId }, { jobId: taskId })
}

export function getRenderQueue() {
  renderQueue ??= new Queue(RENDER_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 10_000,
      },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return renderQueue
}

export async function enqueueProjectRenderTask(taskId: string) {
  await getRenderQueue().add('render-project', { taskId }, { jobId: taskId })
}
