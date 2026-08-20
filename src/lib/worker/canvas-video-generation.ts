import { UnrecoverableError } from 'bullmq'
import { BillingTaskType, CanvasNodeType, Prisma, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import {
  canvasVideoFaceFallbackModel,
  readableCanvasVideoError,
} from '@/lib/creative-canvas'
import {
  downloadOpenAIVideo,
  extractVideoUrl,
  isUnrecoverableVideoGenerationError,
  shouldResetVideoProviderJobOnRetry,
  retrieveVideoJob,
  selectVideoCapability,
  submitVideoGeneration,
} from '@/lib/openai-video'
import { resolveVideoApiProvider } from '@/lib/video-api-pool'
import { resolveVideoModelDefinition } from '@/lib/video-models'
import { deleteStorageObject, buildCanvasStorageKey, signedMediaUrl, uploadBuffer } from '@/lib/storage'

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function videoDimensions(aspectRatio: string, resolution: string) {
  const short = resolution === '480p' ? 480
    : resolution === '1080p' ? 1080
      : resolution === '2k' ? 1440
        : resolution === '4k' ? 2160 : 720
  const dimensions: Record<string, [number, number]> = {
    '16:9': [Math.round(short * 16 / 9), short],
    '9:16': [short, Math.round(short * 16 / 9)],
    '1:1': [short, short],
    '21:9': [Math.round(short * 21 / 9), short],
    '3:4': [short, Math.round(short * 4 / 3)],
    '4:3': [Math.round(short * 4 / 3), short],
  }
  const [width, height] = dimensions[aspectRatio] || dimensions['16:9']
  return { width, height }
}

function payloadRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

export async function processCanvasVideoTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  let pendingStorageKey: string | null = null
  const task = await prisma.canvasVideoTask.findUnique({
    where: { id: taskId },
    include: { node: { include: { media: true } }, canvas: true },
  })
  if (!task || task.node.type !== CanvasNodeType.video) {
    throw new Error(`Canvas video task or node not found: ${taskId}`)
  }
  const payload = payloadRecord(task.payload)
  if (task.status === TaskStatus.completed) return payload

  await prisma.canvasVideoTask.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.processing,
      progress: Math.max(2, task.progress),
      startedAt: task.startedAt || new Date(),
      completedAt: null,
      error: null,
    },
  })

  try {
    const references = task.referenceNodeIds.length > 0
      ? await prisma.canvasNode.findMany({
          where: { id: { in: task.referenceNodeIds }, canvasId: task.canvasId },
          include: { media: true },
        })
      : []
    const referenceById = new Map(references.map((node) => [node.id, node]))
    const orderedReferences = task.referenceNodeIds.map((nodeId) => referenceById.get(nodeId))
    if (orderedReferences.some((node) => (
      !node?.media
      || (node.type === CanvasNodeType.image && !node.media.mimeType.startsWith('image/'))
      || (node.type === CanvasNodeType.video && !node.media.mimeType.startsWith('video/'))
      || (node.type === CanvasNodeType.audio && !node.media.mimeType.startsWith('audio/'))
    ))) {
      throw new Error('VIDEO_REFERENCE_REQUIRED: 连线素材已被删除或不可用')
    }
    const imageReferences = orderedReferences.filter((node) => node?.type === CanvasNodeType.image)
    const videoReferences = orderedReferences.filter((node) => node?.type === CanvasNodeType.video)
    const audioReferences = orderedReferences.filter((node) => node?.type === CanvasNodeType.audio)
    const referenceImageUrls = await Promise.all(imageReferences.map((node) => (
      signedMediaUrl(node!.media!.storageKey, { expiresInSeconds: 60 * 60 })
    )))
    const referenceVideoUrls = await Promise.all(videoReferences.map((node) => (
      signedMediaUrl(node!.media!.storageKey, { expiresInSeconds: 60 * 60 })
    )))
    const referenceAudioUrls = await Promise.all(audioReferences.map((node) => (
      signedMediaUrl(node!.media!.storageKey, { expiresInSeconds: 60 * 60 })
    )))
    const configuredMode = env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok'
    const provider = await resolveVideoApiProvider({
      baseUrl: env.videoApiBaseUrl(),
      model: task.model,
      mode: configuredMode,
      preferredKeySlot: task.providerJobId ? Number(payload.videoApiKeySlot) : undefined,
    })
    const capability = selectVideoCapability([task.model], task.model, configuredMode)
    if (!provider || !capability) throw new Error(`VIDEO_MODEL_UNAVAILABLE: ${task.model}`)
    const config = provider.config
    const modelDefinition = await resolveVideoModelDefinition(task.model).catch(() => null)
    const payloadImageLimit = Number(payload.maximumReferenceImages)
    const maximumReferenceImages = Number.isFinite(payloadImageLimit)
      ? Math.max(0, payloadImageLimit)
      : modelDefinition?.maximumReferenceImages ?? referenceImageUrls.length
    const payloadVideoLimit = Number(payload.maximumReferenceVideos)
    const maximumReferenceVideos = Number.isFinite(payloadVideoLimit)
      ? Math.max(0, payloadVideoLimit)
      : modelDefinition?.maximumReferenceVideos ?? referenceVideoUrls.length
    const payloadAudioLimit = Number(payload.maximumReferenceAudios)
    const maximumReferenceAudios = Number.isFinite(payloadAudioLimit)
      ? Math.max(0, payloadAudioLimit)
      : modelDefinition?.maximumReferenceAudios ?? referenceAudioUrls.length
    const dimensions = videoDimensions(task.aspectRatio, task.resolution)
    const submitted = task.providerJobId
      ? await retrieveVideoJob(config, task.providerJobId)
      : await submitVideoGeneration(config, capability, {
          prompt: task.prompt,
          seconds: task.duration,
          size: `${dimensions.width}x${dimensions.height}`,
          aspectRatio: task.aspectRatio as '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3',
          resolution: task.resolution as '480p' | '720p' | '1080p' | '2k' | '4k',
          referenceImageUrls,
          maximumReferenceImages,
          referenceVideoUrls,
          maximumReferenceVideos,
          referenceAudioUrls,
          maximumReferenceAudios,
          generateAudio: task.generateAudio,
        })
    payload.providerJobId = submitted.id
    payload.videoApiKeySlot = provider.keySlot
    await prisma.canvasVideoTask.update({
      where: { id: task.id },
      data: {
        providerJobId: submitted.id,
        progress: submitted.status.toLowerCase() === 'completed' ? 92 : Math.max(5, submitted.progress || 5),
        payload: payload as Prisma.InputJsonObject,
      },
    })

    let current = submitted
    const startedPollingAt = Date.now()
    const deadline = Date.now() + 30 * 60_000
    while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
      if (Date.now() > deadline) throw new Error(`VIDEO_TASK_TIMEOUT: ${submitted.id}`)
      await sleep(10_000)
      current = await retrieveVideoJob(config, submitted.id)
      const elapsed = Math.min(88, 8 + Math.floor((Date.now() - startedPollingAt) / 12_000))
      await prisma.canvasVideoTask.update({
        where: { id: task.id },
        data: {
          progress: current.progress == null
            ? elapsed
            : Math.min(92, Math.max(5, Math.round(current.progress))),
        },
      })
    }
    if (current.status.toLowerCase() !== 'completed') {
      throw new Error(`VIDEO_TASK_FAILED: ${JSON.stringify(current.raw)}`)
    }

    await recordCompletedUsage({
      idempotencyKey: `canvas-video-task:${task.id}:video`,
      userId: task.createdById,
      taskType: BillingTaskType.video,
      sourceType: 'canvas_video_task',
      sourceTaskId: task.id,
      model: capability.model,
      durationSeconds: task.duration,
    })

    const resultUrl = extractVideoUrl(current.raw)
    let bytes: Uint8Array
    let mimeType = 'video/mp4'
    if (resultUrl) {
      const response = await fetch(resultUrl)
      if (!response.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED: HTTP ${response.status}`)
      const responseType = response.headers.get('content-type')?.split(';')[0]
      if (responseType?.startsWith('video/')) mimeType = responseType
      bytes = new Uint8Array(await response.arrayBuffer())
    } else {
      bytes = await downloadOpenAIVideo(config, submitted.id)
    }
    if (bytes.byteLength < 1024) throw new Error(`VIDEO_DOWNLOAD_EMPTY: ${bytes.byteLength} bytes`)

    const storageKey = buildCanvasStorageKey({
      canvasId: task.canvasId,
      nodeId: task.nodeId,
      mimeType,
    })
    await uploadBuffer({ key: storageKey, body: Buffer.from(bytes), mimeType })
    pendingStorageKey = storageKey
    const media = await prisma.$transaction(async (tx) => {
      const created = await tx.mediaObject.create({
        data: {
          kind: 'video',
          storageKey,
          mimeType,
          sizeBytes: BigInt(bytes.byteLength),
          width: dimensions.width,
          height: dimensions.height,
        },
      })
      await tx.canvasNode.update({ where: { id: task.nodeId }, data: { mediaId: created.id } })
      await tx.canvasVideoTask.update({
        where: { id: task.id },
        data: {
          status: TaskStatus.completed,
          progress: 100,
          completedAt: new Date(),
          error: null,
          payload: { ...payload, resultMediaId: created.id } as Prisma.InputJsonObject,
        },
      })
      await tx.creativeCanvas.update({ where: { id: task.canvasId }, data: { updatedAt: new Date() } })
      if (task.node.mediaId) await tx.mediaObject.delete({ where: { id: task.node.mediaId } })
      return created
    })
    if (task.node.media?.storageKey) {
      await deleteStorageObject(task.node.media.storageKey).catch(() => undefined)
    }
    pendingStorageKey = null
    return { taskId: task.id, mediaId: media.id }
  } catch (error) {
    if (pendingStorageKey) {
      await deleteStorageObject(pendingStorageKey).catch(() => undefined)
      pendingStorageKey = null
    }
    const message = error instanceof Error ? error.message : String(error)
    const unrecoverable = isUnrecoverableVideoGenerationError(error)
    const willRetry = options.willRetryOnFailure === true && !unrecoverable
    const resetProviderJob = willRetry && shouldResetVideoProviderJobOnRetry(message)
    const fallbackModel = canvasVideoFaceFallbackModel(task.model, message)
    payload.providerError = message.slice(0, 8_000)
    if (resetProviderJob) {
      payload.providerJobId = null
      payload.videoApiKeySlot = null
    }
    if (fallbackModel) payload.suggestedFallbackModel = fallbackModel
    await prisma.$transaction(async (tx) => {
      await tx.canvasVideoTask.update({
        where: { id: task.id },
        data: {
          status: willRetry ? TaskStatus.queued : TaskStatus.failed,
          progress: willRetry ? 3 : undefined,
          providerJobId: resetProviderJob ? null : undefined,
          completedAt: willRetry ? null : new Date(),
          error: willRetry ? null : readableCanvasVideoError(message),
          payload: payload as Prisma.InputJsonObject,
        },
      })
      if (fallbackModel && !willRetry) {
        await tx.canvasNode.updateMany({
          where: { id: task.nodeId, model: task.model },
          data: { model: fallbackModel },
        })
      }
    })
    if (unrecoverable) throw new UnrecoverableError(message)
    throw error
  }
}
