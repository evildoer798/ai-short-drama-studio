import { Queue } from 'bullmq'
import { env } from './env'

export const IMAGE_QUEUE_NAME = 'shortdrama-image-generation'
export const TEXT_QUEUE_NAME = 'shortdrama-text-generation'
export const VIDEO_QUEUE_NAME = 'shortdrama-video-generation'
export const CANVAS_VIDEO_QUEUE_NAME = 'shortdrama-canvas-video-generation'
export const CANVAS_IMAGE_QUEUE_NAME = 'shortdrama-canvas-image-generation'
export const CANVAS_AUDIO_QUEUE_NAME = 'shortdrama-canvas-audio-generation'
export const DIRECTOR_STAGE_QUEUE_NAME = 'shortdrama-director-stage-generation'
export const DIRECTOR_VIDEO_QUEUE_NAME = 'shortdrama-director-video-generation'
export const DIRECTOR_IMAGE_QUEUE_NAME = 'shortdrama-director-image-generation'

let imageQueue: Queue | null = null
let textQueue: Queue | null = null
let videoQueue: Queue | null = null
let canvasVideoQueue: Queue | null = null
let canvasImageQueue: Queue | null = null
let canvasAudioQueue: Queue | null = null
let directorStageQueue: Queue | null = null
let directorVideoQueue: Queue | null = null
let directorImageQueue: Queue | null = null

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

export function getCanvasVideoQueue() {
  canvasVideoQueue ??= new Queue(CANVAS_VIDEO_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return canvasVideoQueue
}

export async function enqueueCanvasVideoTask(taskId: string) {
  await getCanvasVideoQueue().add('generate-canvas-video', { taskId }, { jobId: taskId })
}

export function getCanvasImageQueue() {
  canvasImageQueue ??= new Queue(CANVAS_IMAGE_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 20_000 },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return canvasImageQueue
}

export async function enqueueCanvasImageTask(taskId: string) {
  await getCanvasImageQueue().add('generate-canvas-image', { taskId }, { jobId: taskId })
}

export function getCanvasAudioQueue() {
  canvasAudioQueue ??= new Queue(CANVAS_AUDIO_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 20_000 },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return canvasAudioQueue
}

export async function enqueueCanvasAudioTask(taskId: string) {
  await getCanvasAudioQueue().add('generate-canvas-audio', { taskId }, { jobId: taskId })
}

export function getDirectorStageQueue() {
  directorStageQueue ??= new Queue(DIRECTOR_STAGE_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return directorStageQueue
}

export async function enqueueDirectorStageVersion(stageVersionId: string) {
  await getDirectorStageQueue().add('generate-director-stage', { stageVersionId }, { jobId: stageVersionId })
}

export function getDirectorVideoQueue() {
  directorVideoQueue ??= new Queue(DIRECTOR_VIDEO_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return directorVideoQueue
}

export async function enqueueDirectorVideoTask(taskId: string) {
  await getDirectorVideoQueue().add('generate-director-video', { taskId }, { jobId: taskId })
}

export function getDirectorImageQueue() {
  directorImageQueue ??= new Queue(DIRECTOR_IMAGE_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 20_000 },
      removeOnComplete: 100,
      removeOnFail: 300,
    },
  })
  return directorImageQueue
}

export async function enqueueDirectorImageTask(taskId: string) {
  await getDirectorImageQueue().add('generate-director-image', { taskId, kind: 'keyframe' }, { jobId: taskId })
}

export async function enqueueDirectorStateImageTask(taskId: string) {
  await getDirectorImageQueue().add('generate-director-state-image', { taskId, kind: 'character-state' }, { jobId: taskId })
}
