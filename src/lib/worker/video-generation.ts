import { AssetType, Prisma, TaskStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import {
  detectVideoCapability,
  downloadOpenAIVideo,
  extractVideoUrl,
  retrieveVideoJob,
  submitVideoGeneration,
} from '@/lib/openai-video'
import {
  buildStoryboardStorageKey,
  downloadBuffer,
  uploadBuffer,
} from '@/lib/storage'

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const supportedAspectRatios = ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'] as const
type SupportedAspectRatio = typeof supportedAspectRatios[number]
type SupportedResolution = '480p' | '720p'

function taskPayload(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function payloadStringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))]
    : []
}

function normalizeAspectRatio(value: unknown): SupportedAspectRatio {
  const candidate = String(value || '')
  return supportedAspectRatios.find((ratio) => ratio === candidate) || '16:9'
}

function normalizeResolution(value: unknown, model: string): SupportedResolution {
  if (value === '480p' || value === '720p') return value
  return /(?:-|^)480p(?:-|$)/i.test(model) ? '480p' : '720p'
}

function requestedVideoDimensions(aspectRatio: SupportedAspectRatio, resolution: SupportedResolution) {
  const dimensions = resolution === '480p'
    ? {
        '16:9': [864, 496],
        '9:16': [496, 864],
        '1:1': [496, 496],
        '21:9': [1152, 496],
        '3:4': [496, 656],
        '4:3': [656, 496],
      }
    : {
        '16:9': [1280, 720],
        '9:16': [720, 1280],
        '1:1': [720, 720],
        '21:9': [1680, 720],
        '3:4': [720, 960],
        '4:3': [960, 720],
      }
  const [width, height] = dimensions[aspectRatio]
  return { width, height }
}

export async function processVideoGenerationTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.generationTask.findUnique({
    where: { id: taskId },
    include: {
      storyboard: {
        include: {
          project: true,
          episode: { select: { content: true } },
          assetLinks: {
            include: {
              asset: {
                include: {
                  selectedImage: { include: { media: true } },
                },
              },
            },
            orderBy: { referenceOrder: 'asc' },
          },
        },
      },
    },
  })

  if (!task?.storyboard) {
    throw new Error(`Video task or storyboard not found: ${taskId}`)
  }
  const payload = taskPayload(task.payload)
  if (task.status === TaskStatus.completed) return payload

  const checkpointVideoId = typeof payload.storyboardVideoId === 'string'
    ? payload.storyboardVideoId
    : ''
  const checkpointProviderJobId = typeof payload.providerJobId === 'string'
    ? payload.providerJobId
    : ''
  const existingVideo = checkpointVideoId || checkpointProviderJobId
    ? await prisma.storyboardVideo.findFirst({
        where: {
          storyboardId: task.storyboard.id,
          ...(checkpointVideoId
            ? { id: checkpointVideoId }
            : { providerJobId: checkpointProviderJobId }),
        },
      })
    : null
  if (existingVideo) {
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.completed,
        progress: 100,
        completedAt: new Date(),
        error: null,
        payload: { ...payload, storyboardVideoId: existingVideo.id },
      },
    })
    return existingVideo
  }

  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.processing,
      progress: 2,
      startedAt: new Date(),
      error: null,
    },
  })

  try {
    const storyboard = task.storyboard
    const duration = Number(payload.duration || storyboard.duration)
    const aspectRatio = normalizeAspectRatio(payload.aspectRatio || storyboard.aspectRatio)
    const resolution = normalizeResolution(payload.resolution, task.model)
    const dimensions = requestedVideoDimensions(aspectRatio, resolution)
    const generateAudio = payload.generateAudio === undefined
      ? storyboard.generateAudio
      : Boolean(payload.generateAudio)
    const sourceStoryboardIds = payloadStringArray(payload.sourceStoryboardIds)
    if (sourceStoryboardIds.length === 0) sourceStoryboardIds.push(storyboard.id)
    const requestedReferenceAssetIds = payloadStringArray(payload.referenceAssetIds).slice(0, 4)
    const requestedReferenceAssets = requestedReferenceAssetIds.length > 0
      ? await prisma.asset.findMany({
          where: {
            id: { in: requestedReferenceAssetIds },
            projectId: storyboard.projectId,
            type: { in: [AssetType.character, AssetType.location] },
          },
          include: {
            selectedImage: { include: { media: true } },
          },
        })
      : []
    const requestedReferenceAssetsById = new Map(
      requestedReferenceAssets.map((asset) => [asset.id, asset]),
    )
    const references = requestedReferenceAssetIds.length > 0
      ? requestedReferenceAssetIds.flatMap((assetId, index) => {
          const asset = requestedReferenceAssetsById.get(assetId)
          return asset?.selectedImage?.media
            ? [{ assetId, referenceOrder: index + 1, asset }]
            : []
        })
      : storyboard.assetLinks
          .filter((link) => (
            (link.asset.type === AssetType.character || link.asset.type === AssetType.location)
            && link.asset.selectedImage?.media
          ))
          .slice(0, 4)

    if (references.length === 0) {
      throw new Error('VIDEO_REFERENCE_REQUIRED: 分镜没有匹配到已设置主图的资产')
    }

    const referenceImageUrls = await Promise.all(references.map(async (link) => {
      const media = link.asset.selectedImage!.media
      const bytes = await downloadBuffer(media.storageKey)
      return `data:${media.mimeType};base64,${bytes.toString('base64')}`
    }))
    const config = {
      baseUrl: env.videoApiBaseUrl(),
      apiKey: env.videoApiKey(),
      mode: env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok',
      model: task.model,
    }
    const capability = await detectVideoCapability(config)
    if (!capability) {
      throw new Error(`VIDEO_MODEL_UNAVAILABLE: ${task.model}`)
    }
    const prompt = task.prompt.trim()
    if (!prompt) throw new Error('VIDEO_PROMPT_REQUIRED: 视频提示词不能为空')

    const existingProviderJobId = typeof payload.providerJobId === 'string'
      ? payload.providerJobId.trim()
      : ''
    const submitted = existingProviderJobId
      ? await retrieveVideoJob(config, existingProviderJobId)
      : await submitVideoGeneration(config, capability, {
          prompt,
          seconds: duration,
          size: `${dimensions.width}x${dimensions.height}`,
          aspectRatio,
          resolution,
          referenceImageUrls,
          generateAudio,
        })
    Object.assign(payload, {
      aspectRatio,
      resolution,
      providerJobId: submitted.id,
      sourceStoryboardIds,
      referenceAssetIds: references.map((link) => link.assetId),
    })
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        progress: submitted.status.toLowerCase() === 'completed' ? 92 : 5,
        payload: payload as Prisma.InputJsonObject,
      },
    })

    const deadline = Date.now() + 30 * 60 * 1000
    const startedPollingAt = Date.now()
    let current = submitted
    while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
      if (Date.now() > deadline) {
        throw new Error(`VIDEO_TASK_TIMEOUT: ${submitted.id}`)
      }
      await sleep(10_000)
      current = await retrieveVideoJob(config, submitted.id)
      const elapsedProgress = Math.min(88, 8 + Math.floor((Date.now() - startedPollingAt) / 12_000))
      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          progress: current.progress == null
            ? elapsedProgress
            : Math.min(92, Math.max(5, Math.round(current.progress))),
        },
      })
    }
    if (current.status.toLowerCase() !== 'completed') {
      throw new Error(`VIDEO_TASK_FAILED: ${JSON.stringify(current.raw)}`)
    }

    const resultUrl = extractVideoUrl(current.raw)
    let bytes: Uint8Array
    let mimeType = 'video/mp4'
    if (resultUrl) {
      const response = await fetch(resultUrl)
      if (!response.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED: HTTP ${response.status}`)
      mimeType = response.headers.get('content-type')?.split(';')[0] || mimeType
      bytes = new Uint8Array(await response.arrayBuffer())
    } else {
      bytes = await downloadOpenAIVideo(config, submitted.id)
    }

    const storageKey = buildStoryboardStorageKey({
      projectId: storyboard.projectId,
      storyboardId: storyboard.id,
      mimeType,
    })
    await uploadBuffer({
      key: storageKey,
      body: Buffer.from(bytes),
      mimeType,
    })

    const video = await prisma.$transaction(async (tx) => {
      const media = await tx.mediaObject.create({
        data: {
          kind: 'video',
          storageKey,
          mimeType,
          sizeBytes: BigInt(bytes.byteLength),
          width: dimensions.width,
          height: dimensions.height,
        },
      })
      const created = await tx.storyboardVideo.create({
        data: {
          storyboardId: storyboard.id,
          sourceStoryboardIds,
          mediaId: media.id,
          prompt,
          model: capability.model,
          providerJobId: submitted.id,
          duration,
          aspectRatio,
          isSelected: !storyboard.selectedVideoId,
        },
      })
      if (!storyboard.selectedVideoId) {
        await tx.storyboard.update({
          where: { id: storyboard.id },
          data: { selectedVideoId: created.id },
        })
      }
      return created
    })

    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.completed,
        progress: 100,
        completedAt: new Date(),
        payload: {
          ...payload,
          aspectRatio,
          resolution,
          providerJobId: submitted.id,
          storyboardVideoId: video.id,
          sourceStoryboardIds,
          referenceAssetIds: references.map((link) => link.assetId),
        },
      },
    })

    return video
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const willRetry = options.willRetryOnFailure === true
    const retryPayload = willRetry && /VIDEO_TASK_FAILED/i.test(message)
      ? { ...payload, providerJobId: null }
      : payload
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: willRetry ? TaskStatus.queued : TaskStatus.failed,
        completedAt: willRetry ? null : new Date(),
        error: willRetry ? null : message,
        payload: retryPayload as Prisma.InputJsonObject,
      },
    })
    throw error
  }
}
