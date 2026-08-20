import { BillingTaskType, Prisma, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import {
  downloadOpenAIVideo,
  extractVideoUrl,
  retrieveVideoJob,
  selectVideoCapability,
  submitVideoGeneration,
} from '@/lib/openai-video'
import { resolveVideoApiProvider } from '@/lib/video-api-pool'
import { resolveVideoModelDefinition } from '@/lib/video-models'
import { createReferenceMontage } from '@/lib/reference-montage'
import {
  buildDirectorReferenceMontageStorageKey,
  buildDirectorStorageKey,
  downloadBuffer,
  signedMediaUrl,
  uploadBuffer,
} from '@/lib/storage'
import { planVideoReferences } from '@/lib/video-reference-plan'

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function payloadRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function dimensions(aspectRatio: string, resolution: string) {
  const short = resolution === '480p' ? 480
    : resolution === '1080p' ? 1080
      : resolution === '2k' ? 1440
        : resolution === '4k' ? 2160 : 720
  const values: Record<string, [number, number]> = {
    '16:9': [Math.round(short * 16 / 9), short],
    '9:16': [short, Math.round(short * 16 / 9)],
    '1:1': [short, short],
    '21:9': [Math.round(short * 21 / 9), short],
    '3:4': [short, Math.round(short * 4 / 3)],
    '4:3': [Math.round(short * 4 / 3), short],
  }
  const [width, height] = values[aspectRatio] || values['16:9']
  return { width, height }
}

export async function processDirectorVideoTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.directorVideoTask.findUnique({
    where: { id: taskId },
    include: { shot: { include: { production: true } }, videoVersion: true },
  })
  if (!task) throw new Error(`DIRECTOR_VIDEO_TASK_NOT_FOUND: ${taskId}`)
  if (task.status === TaskStatus.completed) return task.videoVersion
  const payload = payloadRecord(task.payload)

  await prisma.directorVideoTask.update({
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
    const mode = env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok'
    const provider = await resolveVideoApiProvider({
      baseUrl: env.videoApiBaseUrl(),
      model: task.model,
      mode,
      preferredKeySlot: task.providerJobId ? Number(payload.videoApiKeySlot) : undefined,
    })
    const capability = selectVideoCapability([task.model], task.model, mode)
    const definition = await resolveVideoModelDefinition(task.model)
    if (!provider || !capability || !definition) throw new Error(`VIDEO_MODEL_UNAVAILABLE: ${task.model}`)
    const size = dimensions(task.aspectRatio, task.resolution)
    let current
    if (task.providerJobId) {
      current = await retrieveVideoJob(provider.config, task.providerJobId)
    } else {
      const referencePlan = planVideoReferences(
        task.referenceMediaIds,
        definition.maximumReferenceImages,
        definition.maximumReferenceVideos || 0,
      )
      if (referencePlan.rejectedMediaIds.length > 0) {
        throw new Error(`VIDEO_REFERENCE_LIMIT: 当前模型最多接收 ${referencePlan.totalCapacity} 项图片资产`)
      }
      const references = task.referenceMediaIds.length
        ? await prisma.mediaObject.findMany({
            where: { id: { in: task.referenceMediaIds }, mimeType: { startsWith: 'image/' } },
          })
        : []
      const byId = new Map(references.map((media) => [media.id, media]))
      if (task.referenceMediaIds.some((id) => !byId.has(id))) {
        throw new Error('VIDEO_REFERENCE_REQUIRED: 部分关键帧参考素材不可用')
      }
      const referenceImageUrls = await Promise.all(referencePlan.imageMediaIds.map((id) => (
        signedMediaUrl(byId.get(id)!.storageKey, { expiresInSeconds: 60 * 60 })
      )))

      const cachedVideoIds = Array.isArray(payload.referenceVideoMediaIds)
        ? payload.referenceVideoMediaIds.filter((id): id is string => typeof id === 'string')
        : []
      const cachedVideos = cachedVideoIds.length === referencePlan.videoGroups.length
        ? await prisma.mediaObject.findMany({
            where: { id: { in: cachedVideoIds }, mimeType: 'video/mp4' },
          })
        : []
      const cachedById = new Map(cachedVideos.map((media) => [media.id, media]))
      let orderedVideos = cachedVideoIds.map((id) => cachedById.get(id)).filter(Boolean)
      if (orderedVideos.length !== referencePlan.videoGroups.length) {
        orderedVideos = []
        for (const [groupIndex, group] of referencePlan.videoGroups.entries()) {
          const images = await Promise.all(group.map(async (id) => {
            const media = byId.get(id)!
            return { bytes: await downloadBuffer(media.storageKey), mimeType: media.mimeType }
          }))
          const montage = await createReferenceMontage({ images, width: size.width, height: size.height })
          const storageKey = buildDirectorReferenceMontageStorageKey({
            productionId: task.shot.productionId,
            shotId: task.shotId,
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
          orderedVideos.push(media)
        }
        payload.referencePlan = referencePlan
        payload.referenceVideoMediaIds = orderedVideos.map((media) => media!.id)
        await prisma.directorVideoTask.update({
          where: { id: task.id },
          data: { progress: Math.max(4, task.progress), payload: payload as Prisma.InputJsonObject },
        })
      }
      const referenceVideoUrls = await Promise.all(orderedVideos.map((media) => (
        signedMediaUrl(media!.storageKey, { expiresInSeconds: 60 * 60 })
      )))
      current = await submitVideoGeneration(provider.config, capability, {
          prompt: task.prompt,
          seconds: task.duration,
          size: `${size.width}x${size.height}`,
          aspectRatio: task.aspectRatio as '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3',
          resolution: task.resolution as '480p' | '720p' | '1080p' | '2k' | '4k',
          referenceImageUrls,
          maximumReferenceImages: definition.maximumReferenceImages,
          referenceVideoUrls,
          maximumReferenceVideos: definition.maximumReferenceVideos,
          generateAudio: task.generateAudio,
        })
    }
    payload.videoApiKeySlot = provider.keySlot
    await prisma.directorVideoTask.update({
      where: { id: task.id },
      data: {
        providerJobId: current.id,
        progress: Math.max(5, current.progress || 5),
        payload: payload as Prisma.InputJsonObject,
      },
    })
    const deadline = Date.now() + 30 * 60_000
    while (!['completed', 'failed'].includes(current.status.toLowerCase())) {
      if (Date.now() > deadline) throw new Error(`VIDEO_TASK_TIMEOUT: ${current.id}`)
      await sleep(10_000)
      current = await retrieveVideoJob(provider.config, current.id)
      await prisma.directorVideoTask.update({
        where: { id: task.id },
        data: { progress: Math.min(92, Math.max(5, Math.round(current.progress || 10))) },
      })
    }
    if (current.status.toLowerCase() !== 'completed') throw new Error(`VIDEO_TASK_FAILED: ${JSON.stringify(current.raw)}`)

    await recordCompletedUsage({
      idempotencyKey: `director-video-task:${task.id}:video`,
      userId: task.createdById,
      taskType: BillingTaskType.video,
      sourceType: 'director_video_task',
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
      const returnedType = response.headers.get('content-type')?.split(';')[0]
      if (returnedType?.startsWith('video/')) mimeType = returnedType
      bytes = new Uint8Array(await response.arrayBuffer())
    } else {
      bytes = await downloadOpenAIVideo(provider.config, current.id)
    }
    if (bytes.byteLength < 1024) throw new Error(`VIDEO_DOWNLOAD_EMPTY: ${bytes.byteLength} bytes`)
    const storageKey = buildDirectorStorageKey({
      productionId: task.shot.productionId,
      shotId: task.shotId,
      mimeType,
    })
    await uploadBuffer({ key: storageKey, body: Buffer.from(bytes), mimeType })
    const created = await prisma.$transaction(async (tx) => {
      const media = await tx.mediaObject.create({
        data: {
          kind: 'video', storageKey, mimeType, sizeBytes: BigInt(bytes.byteLength),
          width: size.width, height: size.height,
        },
      })
      const aggregate = await tx.directorVideoVersion.aggregate({
        where: { shotId: task.shotId }, _max: { version: true },
      })
      const version = await tx.directorVideoVersion.create({
        data: {
          shotId: task.shotId,
          taskId: task.id,
          mediaId: media.id,
          version: (aggregate._max.version || 0) + 1,
          name: `版本 ${(aggregate._max.version || 0) + 1}`,
          model: task.model,
          prompt: task.prompt,
          duration: task.duration,
          aspectRatio: task.aspectRatio,
        },
      })
      await tx.directorVideoTask.update({
        where: { id: task.id },
        data: { status: TaskStatus.completed, progress: 100, completedAt: new Date(), error: null },
      })
      return version
    })
    return created
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.directorVideoTask.update({
      where: { id: task.id },
      data: {
        status: options.willRetryOnFailure ? TaskStatus.queued : TaskStatus.failed,
        completedAt: options.willRetryOnFailure ? null : new Date(),
        error: message.slice(0, 8000),
      },
    })
    throw error
  }
}
