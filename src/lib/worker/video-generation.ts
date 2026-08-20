import { UnrecoverableError } from 'bullmq'
import { AssetType, BillingTaskType, Prisma, TaskStatus, VisualStyle } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
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
import { normalizeVideoDuration } from '@/lib/video-batch'
import { resolveVideoModelDefinition } from '@/lib/video-models'
import { createReferenceMontage } from '@/lib/reference-montage'
import {
  planVideoReferences,
  REFERENCE_MONTAGE_IMAGES_PER_VIDEO,
} from '@/lib/video-reference-plan'
import {
  prepareSingleCharacterReference,
  shouldPrepareSingleCharacterReference,
} from '@/lib/video-character-reference'
import {
  isExcludedStoryboardAssetLink,
  prioritizeStoryboardReferences,
} from '@/lib/storyboards'
import {
  buildStoryboardReferenceMontageStorageKey,
  buildStoryboardStorageKey,
  downloadBuffer,
  signedMediaUrl,
  uploadBuffer,
} from '@/lib/storage'

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const supportedAspectRatios = ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'] as const
type SupportedAspectRatio = typeof supportedAspectRatios[number]
type SupportedResolution = '480p' | '720p' | '1080p'

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

class VideoTaskCancelledError extends Error {
  constructor(message = 'VIDEO_TASK_CANCELLED: 用户取消了该视频生成任务。') {
    super(message)
    this.name = 'VideoTaskCancelledError'
  }
}

async function throwIfVideoTaskCancelled(taskId: string) {
  const latest = await prisma.generationTask.findUnique({
    where: { id: taskId },
    select: { status: true, error: true, payload: true },
  })
  const latestPayload = taskPayload(latest?.payload)
  if (latestPayload.cancelRequested === true || /VIDEO_TASK_CANCELLED/iu.test(latest?.error || '')) {
    throw new VideoTaskCancelledError(latest?.error || undefined)
  }
}

function normalizeAspectRatio(value: unknown): SupportedAspectRatio {
  const candidate = String(value || '')
  return supportedAspectRatios.find((ratio) => ratio === candidate) || '16:9'
}

function normalizeResolution(value: unknown, model: string): SupportedResolution {
  if (value === '480p' || value === '720p' || value === '1080p') return value
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
    : resolution === '1080p'
      ? {
          '16:9': [1920, 1080],
          '9:16': [1080, 1920],
          '1:1': [1080, 1080],
          '21:9': [2560, 1080],
          '3:4': [1080, 1440],
          '4:3': [1440, 1080],
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
  if (payload.cancelRequested === true) return payload
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
    await recordCompletedUsage({
      idempotencyKey: `generation-task:${task.id}:video`,
      userId: task.createdById,
      taskType: BillingTaskType.video,
      sourceType: 'generation_task',
      sourceTaskId: task.id,
      model: task.model,
      durationSeconds: existingVideo.duration,
    })
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

  await throwIfVideoTaskCancelled(taskId)
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
    await throwIfVideoTaskCancelled(taskId)
    const storyboard = task.storyboard
    const requestedDuration = Number(payload.duration || storyboard.duration)
    let duration = requestedDuration
    const aspectRatio = normalizeAspectRatio(payload.aspectRatio || storyboard.aspectRatio)
    const resolution = normalizeResolution(payload.resolution, task.model)
    const dimensions = requestedVideoDimensions(aspectRatio, resolution)
    const generateAudio = payload.generateAudio === undefined
      ? storyboard.generateAudio
      : Boolean(payload.generateAudio)
    const modelDefinition = await resolveVideoModelDefinition(task.model).catch(() => null)
    const payloadReferenceLimit = Number(payload.maximumReferenceImages)
    const referenceLimit = Number.isInteger(payloadReferenceLimit) && payloadReferenceLimit > 0
      ? payloadReferenceLimit
      : modelDefinition?.maximumReferenceImages
        ?? (/^(?:sd5-seedance-2\.0|happyhouse-(?:1\.0|1\.1))(?:-|$)/i.test(task.model) ? 9 : 4)
    const continuityFrameMediaId = typeof payload.continuityFrameMediaId === 'string'
      ? payload.continuityFrameMediaId.trim()
      : ''
    const continuitySourceVideoId = typeof payload.continuitySourceVideoId === 'string'
      ? payload.continuitySourceVideoId.trim()
      : ''
    const continuitySource = continuityFrameMediaId && continuitySourceVideoId
      ? await prisma.storyboardVideo.findUnique({
          where: { id: continuitySourceVideoId },
          select: {
            id: true,
            tailFrameMediaId: true,
            tailFrameMedia: { select: { storageKey: true, mimeType: true } },
            storyboard: { select: { projectId: true } },
          },
        })
      : null
    if (continuityFrameMediaId && (
      !continuitySource
      || continuitySource.storyboard.projectId !== storyboard.projectId
      || continuitySource.tailFrameMediaId !== continuityFrameMediaId
      || !continuitySource.tailFrameMedia?.mimeType.startsWith('image/')
    )) {
      throw new Error('CONTINUITY_FRAME_INVALID: 上一镜尾帧来源校验失败')
    }
    const assetReferenceLimit = Math.max(0, referenceLimit - (continuitySource ? 1 : 0))
    const maximumReferenceVideos = modelDefinition?.maximumReferenceVideos || 0
    const totalAssetReferenceCapacity = assetReferenceLimit
      + maximumReferenceVideos * REFERENCE_MONTAGE_IMAGES_PER_VIDEO
    const sourceStoryboardIds = payloadStringArray(payload.sourceStoryboardIds)
    if (sourceStoryboardIds.length === 0) sourceStoryboardIds.push(storyboard.id)
    const hasExplicitReferenceAssetIds = Array.isArray(payload.referenceAssetIds)
    const allowTextOnlyCharacters = payload.referenceStrategy === 'text_only_characters'
    const requestedReferenceAssetIds = payloadStringArray(payload.referenceAssetIds)
    const requestedReferenceAssets = requestedReferenceAssetIds.length > 0
      ? await prisma.asset.findMany({
          where: {
            id: { in: requestedReferenceAssetIds },
            projectId: storyboard.projectId,
            type: { in: [AssetType.character, AssetType.location, AssetType.prop] },
          },
          include: {
            selectedImage: { include: { media: true } },
          },
        })
      : []
    const requestedReferenceAssetsById = new Map(
      requestedReferenceAssets.map((asset) => [asset.id, asset]),
    )
    const references = totalAssetReferenceCapacity === 0
      ? []
      : hasExplicitReferenceAssetIds
      ? requestedReferenceAssetIds.flatMap((assetId, index) => {
          const asset = requestedReferenceAssetsById.get(assetId)
          return asset?.selectedImage?.media && !(continuitySource && asset.type === AssetType.location)
            ? [{ assetId, referenceOrder: index + 1, asset }]
            : []
        }).slice(0, totalAssetReferenceCapacity)
      : prioritizeStoryboardReferences(
          storyboard.assetLinks.filter((link) => (
            !isExcludedStoryboardAssetLink(link.matchReason)
            && (link.asset.type === AssetType.character || link.asset.type === AssetType.location || link.asset.type === AssetType.prop)
            && link.asset.selectedImage?.media
          )),
          totalAssetReferenceCapacity,
          { omitLocations: Boolean(continuitySource) },
        )

    const referencePlan = planVideoReferences(
      references.map((link) => link.assetId),
      assetReferenceLimit,
      maximumReferenceVideos,
    )
    if (referencePlan.rejectedMediaIds.length > 0) {
      throw new Error(`VIDEO_REFERENCE_LIMIT: 当前模型最多接收 ${referencePlan.totalCapacity} 项图片资产`)
    }
    const referencesByAssetId = new Map(references.map((link) => [link.assetId, link]))
    const imageReferences = referencePlan.imageMediaIds.map((assetId) => referencesByAssetId.get(assetId)!).filter(Boolean)

    if (references.length === 0 && !continuitySource && !allowTextOnlyCharacters) {
      throw new Error('VIDEO_REFERENCE_REQUIRED: 分镜没有匹配到已设置主图的资产')
    }

    const referenceImageUrls: string[] = []
    const singlePersonReferenceAssetIds: string[] = []
    for (const link of imageReferences) {
      const media = link.asset.selectedImage!.media
      const sourceUrl = await signedMediaUrl(media.storageKey, {
        expiresInSeconds: 60 * 60,
      })
      if (shouldPrepareSingleCharacterReference({
        model: task.model,
        visualStyle: storyboard.project.visualStyle as VisualStyle,
        assetType: link.asset.type,
        prompt: link.asset.prompt,
        description: link.asset.description,
      })) {
        try {
          const prepared = await prepareSingleCharacterReference({ sourceUrl })
          referenceImageUrls.push(prepared.url)
          if (prepared.transformed) singlePersonReferenceAssetIds.push(link.assetId)
          continue
        } catch (error) {
          console.warn(`Failed to prepare single-person reference for ${link.asset.name}`, error)
        }
      }
      referenceImageUrls.push(sourceUrl)
    }
    if (continuitySource?.tailFrameMedia) {
      referenceImageUrls.push(await signedMediaUrl(continuitySource.tailFrameMedia.storageKey, {
        expiresInSeconds: 60 * 60,
      }))
    }
    const cachedVideoIds = payloadStringArray(payload.referenceVideoMediaIds)
    const cachedVideos = cachedVideoIds.length === referencePlan.videoGroups.length
      ? await prisma.mediaObject.findMany({
          where: { id: { in: cachedVideoIds }, mimeType: 'video/mp4' },
        })
      : []
    const cachedVideosById = new Map(cachedVideos.map((media) => [media.id, media]))
    let orderedReferenceVideos = cachedVideoIds.map((id) => cachedVideosById.get(id)).filter(Boolean)
    if (orderedReferenceVideos.length !== referencePlan.videoGroups.length) {
      orderedReferenceVideos = []
      for (const [groupIndex, group] of referencePlan.videoGroups.entries()) {
        await throwIfVideoTaskCancelled(taskId)
        const images = await Promise.all(group.map(async (assetId) => {
          const media = referencesByAssetId.get(assetId)!.asset.selectedImage!.media
          return { bytes: await downloadBuffer(media.storageKey), mimeType: media.mimeType }
        }))
        const montage = await createReferenceMontage({
          images,
          width: dimensions.width,
          height: dimensions.height,
        })
        const storageKey = buildStoryboardReferenceMontageStorageKey({
          projectId: storyboard.projectId,
          storyboardId: storyboard.id,
          taskId: task.id,
          groupIndex,
        })
        await uploadBuffer({ key: storageKey, body: montage.bytes, mimeType: 'video/mp4' })
        const media = await prisma.mediaObject.upsert({
          where: { storageKey },
          create: {
            kind: 'video',
            storageKey,
            mimeType: 'video/mp4',
            sizeBytes: BigInt(montage.bytes.byteLength),
            width: montage.probe.width,
            height: montage.probe.height,
          },
          update: {
            mimeType: 'video/mp4',
            sizeBytes: BigInt(montage.bytes.byteLength),
            width: montage.probe.width,
            height: montage.probe.height,
          },
        })
        orderedReferenceVideos.push(media)
      }
      payload.referencePlan = referencePlan
      payload.referenceVideoMediaIds = orderedReferenceVideos.map((media) => media!.id)
      await prisma.generationTask.update({
        where: { id: task.id },
        data: { progress: Math.max(4, task.progress), payload: payload as Prisma.InputJsonObject },
      })
    }
    const referenceVideoUrls = await Promise.all(orderedReferenceVideos.map((media) => (
      signedMediaUrl(media!.storageKey, { expiresInSeconds: 60 * 60 })
    )))
    const existingProviderJobId = typeof payload.providerJobId === 'string'
      ? payload.providerJobId.trim()
      : ''
    const configuredMode = env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok'
    const provider = await resolveVideoApiProvider({
      baseUrl: env.videoApiBaseUrl(),
      model: task.model,
      mode: configuredMode,
      preferredKeySlot: existingProviderJobId ? Number(payload.videoApiKeySlot) : undefined,
    })
    const capability = selectVideoCapability([task.model], task.model, configuredMode)
    if (!provider || !capability) {
      throw new Error(`VIDEO_MODEL_UNAVAILABLE: ${task.model}`)
    }
    const config = provider.config
    duration = normalizeVideoDuration(
      requestedDuration,
      modelDefinition?.minimumDuration ?? (capability.mode === 'newapi-grok' ? 6 : 4),
      modelDefinition?.maximumDuration ?? 15,
      modelDefinition?.supportedDurations ?? (capability.mode === 'newapi-grok' ? [6, 10, 15] : null),
    )
    const prompt = task.prompt.trim()
    if (!prompt) throw new Error('VIDEO_PROMPT_REQUIRED: 视频提示词不能为空')

    await throwIfVideoTaskCancelled(taskId)
    const submitted = existingProviderJobId
      ? await retrieveVideoJob(config, existingProviderJobId)
      : await submitVideoGeneration(config, capability, {
          prompt,
          seconds: duration,
          size: `${dimensions.width}x${dimensions.height}`,
          aspectRatio,
          resolution,
          referenceImageUrls,
          maximumReferenceImages: referenceLimit,
          referenceVideoUrls,
          maximumReferenceVideos,
          generateAudio,
        })
    await throwIfVideoTaskCancelled(taskId)
    Object.assign(payload, {
      duration,
      aspectRatio,
      resolution,
      providerJobId: submitted.id,
      videoApiKeySlot: provider.keySlot,
      sourceStoryboardIds,
      referenceAssetIds: references.map((link) => link.assetId),
      referenceImageAssetIds: referencePlan.imageMediaIds,
      referenceVideoAssetGroups: referencePlan.videoGroups,
      referenceVideoMediaIds: orderedReferenceVideos.map((media) => media!.id),
      singlePersonReferenceAssetIds,
      maximumReferenceImages: referenceLimit,
      maximumReferenceVideos,
      continuityFrameMediaId: continuitySource?.tailFrameMediaId || null,
      continuitySourceVideoId: continuitySource?.id || null,
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
      await throwIfVideoTaskCancelled(taskId)
      current = await retrieveVideoJob(config, submitted.id)
      await throwIfVideoTaskCancelled(taskId)
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

    await throwIfVideoTaskCancelled(taskId)

    await recordCompletedUsage({
      idempotencyKey: `generation-task:${task.id}:video`,
      userId: task.createdById,
      taskType: BillingTaskType.video,
      sourceType: 'generation_task',
      sourceTaskId: task.id,
      model: capability.model,
      durationSeconds: duration,
    })

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
    await throwIfVideoTaskCancelled(taskId)

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
          videoApiKeySlot: provider.keySlot,
          storyboardVideoId: video.id,
          sourceStoryboardIds,
          referenceAssetIds: references.map((link) => link.assetId),
          referenceImageAssetIds: referencePlan.imageMediaIds,
          referenceVideoAssetGroups: referencePlan.videoGroups,
          referenceVideoMediaIds: orderedReferenceVideos.map((media) => media!.id),
          maximumReferenceImages: referenceLimit,
          maximumReferenceVideos,
          continuityFrameMediaId: continuitySource?.tailFrameMediaId || null,
          continuitySourceVideoId: continuitySource?.id || null,
        },
      },
    })

    return video
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof VideoTaskCancelledError || /VIDEO_TASK_CANCELLED/iu.test(message)) {
      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.failed,
          completedAt: new Date(),
          error: message,
          payload: {
            ...payload,
            cancelRequested: true,
            cancelRequestedAt: payload.cancelRequestedAt || new Date().toISOString(),
          } as Prisma.InputJsonObject,
        },
      })
      throw new UnrecoverableError(message)
    }
    const unrecoverable = isUnrecoverableVideoGenerationError(error)
    const willRetry = options.willRetryOnFailure === true && !unrecoverable
    const retryPayload = willRetry && shouldResetVideoProviderJobOnRetry(message)
      ? { ...payload, providerJobId: null, videoApiKeySlot: null }
      : payload
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: willRetry ? TaskStatus.queued : TaskStatus.failed,
        progress: willRetry ? 3 : undefined,
        completedAt: willRetry ? null : new Date(),
        error: willRetry ? null : message,
        payload: retryPayload as Prisma.InputJsonObject,
      },
    })
    if (unrecoverable) throw new UnrecoverableError(message)
    throw error
  }
}
