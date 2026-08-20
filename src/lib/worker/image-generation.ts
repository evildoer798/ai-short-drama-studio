import { UnrecoverableError } from 'bullmq'
import { BillingTaskType, Prisma, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { buildDefaultPrompt } from '@/lib/assets'
import { env } from '@/lib/env'
import {
  prepareAssetImagePrompt,
  prepareImagePolicyFallbackPrompt,
  prepareImagePolicyRetryPrompt,
} from '@/lib/image-prompt-safety'
import {
  generateImageViaOpenAICompat,
  imageOutputToBuffer,
  isImageContentPolicyError,
  isUnrecoverableImageGenerationError,
  readableImageGenerationError,
  shouldDiscardImageProviderCheckpoint,
} from '@/lib/openai-image'
import { buildStorageKey, uploadBuffer } from '@/lib/storage'
import {
  resolveImageApiProviders,
  shouldFailoverImageApiError,
} from '@/lib/image-api-pool'

type ImageProviderCheckpoint = {
  taskId: string
  pollUrl: string
  apiKeySlot: number
  status: 'submitted' | 'completed' | 'failed'
  submittedAt: string
  updatedAt: string
  error?: string
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function payloadStringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))]
    : []
}

function readProviderCheckpoints(payload: unknown): ImageProviderCheckpoint[] {
  const checkpoints = payloadRecord(payload).imageProviderTasks
  if (!Array.isArray(checkpoints)) return []

  return checkpoints.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    const status = record.status
    if (
      typeof record.taskId !== 'string'
      || typeof record.pollUrl !== 'string'
      || (status !== 'submitted' && status !== 'completed' && status !== 'failed')
    ) return []

    const now = new Date().toISOString()
    return [{
      taskId: record.taskId,
      pollUrl: record.pollUrl,
      apiKeySlot: Number.isInteger(record.apiKeySlot) ? Number(record.apiKeySlot) : 1,
      status,
      submittedAt: typeof record.submittedAt === 'string' ? record.submittedAt : now,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
      ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
    }]
  })
}

export async function processImageGenerationTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.generationTask.findUnique({
    where: { id: taskId },
    include: {
      asset: true,
    },
  })

  if (!task?.asset || !task.assetId) {
    throw new Error(`Image task or asset not found: ${taskId}`)
  }
  const assetId = task.assetId
  const basePayload = payloadRecord(task.payload)
  if (task.status === TaskStatus.completed) return basePayload
  let taskPayloadState = basePayload
  const providerTasks = readProviderCheckpoints(task.payload)
  const resumableTask = [...providerTasks].reverse().find((item) => item.status === 'submitted')
  let resumeProviderTask = resumableTask
    ? {
        taskId: resumableTask.taskId,
        pollUrl: resumableTask.pollUrl,
        apiKeySlot: resumableTask.apiKeySlot,
      }
    : undefined

  const updateProviderCheckpoint = async (update: {
    taskId: string
    pollUrl: string
    status: 'submitted' | 'completed' | 'failed'
    error?: string
  }, apiKeySlot: number) => {
    const now = new Date().toISOString()
    const index = providerTasks.findIndex((item) => (
      item.taskId === update.taskId && item.apiKeySlot === apiKeySlot
    ))
    const previous = index >= 0 ? providerTasks[index] : null
    const checkpoint: ImageProviderCheckpoint = {
      taskId: update.taskId,
      pollUrl: update.pollUrl,
      apiKeySlot,
      status: update.status,
      submittedAt: previous?.submittedAt || now,
      updatedAt: now,
      ...(update.error ? { error: update.error } : {}),
    }
    if (index >= 0) providerTasks[index] = checkpoint
    else providerTasks.push(checkpoint)

    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        progress: update.status === 'submitted' ? 15 : undefined,
        payload: {
          ...taskPayloadState,
          imageProviderTasks: providerTasks,
        } as Prisma.InputJsonValue,
      },
    })
    taskPayloadState = { ...taskPayloadState, imageProviderTasks: providerTasks }
  }

  const closeSubmittedProviderCheckpoints = async (error: unknown) => {
    const now = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    let changed = false
    providerTasks.forEach((checkpoint, index) => {
      if (checkpoint.status !== 'submitted') return
      changed = true
      providerTasks[index] = {
        ...checkpoint,
        status: 'failed',
        updatedAt: now,
        error: message.slice(0, 500),
      }
    })
    resumeProviderTask = undefined
    if (!changed) return
    taskPayloadState = { ...taskPayloadState, imageProviderTasks: providerTasks }
    await prisma.generationTask.update({
      where: { id: taskId },
      data: { payload: taskPayloadState as Prisma.InputJsonObject },
    })
  }

  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.processing,
      startedAt: new Date(),
      error: null,
      progress: 5,
    },
  })

  try {
    const prompt = task.prompt || buildDefaultPrompt(task.asset)
    const preparedPrompt = prepareAssetImagePrompt({
      prompt,
      assetName: task.asset.name,
      assetType: task.asset.type,
    })
    let generationPrompt = preparedPrompt.prompt
    let policyRetryUsed = taskPayloadState.policyRetryUsed === true
    let policyFallbackUsed = taskPayloadState.policyFallbackUsed === true
    if (policyFallbackUsed) {
      generationPrompt = prepareImagePolicyFallbackPrompt({
        prompt,
        assetName: task.asset.name,
        assetType: task.asset.type,
      })
    } else if (policyRetryUsed) {
      generationPrompt = prepareImagePolicyRetryPrompt({
        prompt,
        assetName: task.asset.name,
        assetType: task.asset.type,
      })
    }
    const checkpointImageIds = payloadStringArray(taskPayloadState.imageIds)
    const checkpointImages = checkpointImageIds.length > 0
      ? await prisma.assetImage.findMany({
          where: { id: { in: checkpointImageIds }, assetId },
          include: { media: true },
        })
      : []
    const checkpointImagesById = new Map(checkpointImages.map((image) => [image.id, image]))
    const createdImages = checkpointImageIds.flatMap((id) => {
      const image = checkpointImagesById.get(id)
      return image ? [image] : []
    })
    const latestVariant = await prisma.assetImage.aggregate({
      where: { assetId },
      _max: { variant: true },
    })
    let nextVariant = (latestVariant._max.variant || 0) + 1

    for (let index = createdImages.length; index < task.requestedCount; index++) {
      const requestImageWithProvider = async (
        activePrompt: string,
        provider: { slot: number, apiKey: string, model: string },
        resume = resumeProviderTask,
      ) => ({
        output: await generateImageViaOpenAICompat({
        prompt: activePrompt,
        model: provider.model,
        baseUrl: env.openAICompatBaseUrl(),
        apiKey: provider.apiKey,
        mode: env.imageApiMode(),
        quality: env.imageQuality(),
        size: env.imageSize(),
        outputFormat: env.imageOutputFormat(),
        outputCompression: env.imageOutputCompression(),
        partialImages: env.imagePartialImages(),
        stream: env.imageStream(),
        useAsync: env.imageAsync(),
        providerTimeoutRetries: env.imageProviderTimeoutRetries(),
        resumeProviderTask: index === 0 && resume?.apiKeySlot === provider.slot
          ? { taskId: resume.taskId, pollUrl: resume.pollUrl }
          : undefined,
        onProviderTaskUpdate: (update) => updateProviderCheckpoint(update, provider.slot),
        onRetry: async ({ attempt, maxAttempts, delayMs, message }) => {
          const seconds = Math.max(1, Math.ceil(delayMs / 1000))
          await prisma.generationTask.update({
            where: { id: taskId },
            data: {
              status: TaskStatus.processing,
              progress: Math.min(80, 10 + attempt * 10),
              error: `${message}（第 ${attempt}/${maxAttempts} 次，约 ${seconds} 秒后继续）`,
            },
          })
        },
        }),
        model: provider.model,
      })
      const requestImage = async (activePrompt: string, resume = resumeProviderTask) => {
        const providers = await resolveImageApiProviders({
          baseUrl: env.openAICompatBaseUrl(),
          model: task.model,
          preferredKeySlot: index === 0 ? resume?.apiKeySlot : undefined,
        })
        let lastError: unknown = null

        for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
          const provider = providers[providerIndex]
          try {
            return await requestImageWithProvider(activePrompt, provider, resume)
          } catch (error) {
            lastError = error
            const hasSubmittedTask = providerTasks.some((checkpoint) => (
              checkpoint.apiKeySlot === provider.slot && checkpoint.status === 'submitted'
            ))
            const canTryNext = providerIndex < providers.length - 1
              && !hasSubmittedTask
              && shouldFailoverImageApiError(error)
            if (!canTryNext) throw error
            await prisma.generationTask.update({
              where: { id: taskId },
              data: {
                status: TaskStatus.processing,
                progress: 12,
                error: `Image API slot ${provider.slot} failed; switching to the backup slot.`,
              },
            })
          }
        }

        throw lastError || new Error('IMAGE_API_POOL_UNAVAILABLE')
      }
      let output: Awaited<ReturnType<typeof generateImageViaOpenAICompat>>
      let billedModel = task.model
      while (true) {
        try {
          const generated = await requestImage(generationPrompt)
          output = generated.output
          billedModel = generated.model
          break
        } catch (error) {
          if (!isImageContentPolicyError(error)) throw error
          await closeSubmittedProviderCheckpoints(error)

          if (!policyRetryUsed) {
            policyRetryUsed = true
            generationPrompt = prepareImagePolicyRetryPrompt({
              prompt,
              assetName: task.asset.name,
              assetType: task.asset.type,
            })
            taskPayloadState = {
              ...taskPayloadState,
              imageProviderTasks: providerTasks,
              policyRetryUsed: true,
              policyRetryAt: new Date().toISOString(),
            }
            await prisma.generationTask.update({
              where: { id: taskId },
              data: {
                status: TaskStatus.processing,
                progress: 20,
                error: '图片服务首次审核未通过，系统已自动替换风险词并简化提示词。',
                payload: taskPayloadState as Prisma.InputJsonObject,
              },
            })
            continue
          }

          if (!policyFallbackUsed) {
            policyFallbackUsed = true
            generationPrompt = prepareImagePolicyFallbackPrompt({
              prompt,
              assetName: task.asset.name,
              assetType: task.asset.type,
            })
            taskPayloadState = {
              ...taskPayloadState,
              imageProviderTasks: providerTasks,
              policyFallbackUsed: true,
              policyFallbackAt: new Date().toISOString(),
            }
            await prisma.generationTask.update({
              where: { id: taskId },
              data: {
                status: TaskStatus.processing,
                progress: 30,
                error: '图片服务再次审核未通过，系统正在使用精简安全版本完成最后一次自动提交。',
                payload: taskPayloadState as Prisma.InputJsonObject,
              },
            })
            continue
          }

          throw error
        }
      }
      await recordCompletedUsage({
        idempotencyKey: `generation-task:${task.id}:image:${index}`,
        userId: task.createdById,
        taskType: BillingTaskType.image,
        sourceType: 'generation_task',
        sourceTaskId: task.id,
        model: billedModel,
      })
      resumeProviderTask = undefined
      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          progress: Math.min(90, 60 + Math.round(((index + 1) / task.requestedCount) * 25)),
          error: null,
        },
      })
      const image = await imageOutputToBuffer(output)
      const key = buildStorageKey({
        projectId: task.projectId,
        assetId,
        mimeType: image.mimeType,
      })

      await uploadBuffer({
        key,
        body: image.buffer,
        mimeType: image.mimeType,
      })

      const media = await prisma.mediaObject.create({
        data: {
          kind: 'image',
          storageKey: key,
          mimeType: image.mimeType,
          sizeBytes: BigInt(image.buffer.byteLength),
        },
      })

      const assetImage = await prisma.assetImage.create({
        data: {
          assetId,
          mediaId: media.id,
          prompt,
          variant: nextVariant++,
          isSelected: false,
        },
        include: { media: true },
      })

      createdImages.push(assetImage)
      taskPayloadState = {
        ...taskPayloadState,
        imageProviderTasks: providerTasks,
        imageIds: createdImages.map((created) => created.id),
        mediaIds: createdImages.map((created) => created.mediaId),
      }
      await prisma.generationTask.update({
        where: { id: taskId },
        data: { payload: taskPayloadState as Prisma.InputJsonObject },
      })
    }

    const currentAsset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { selectedImageId: true },
    })

    if (!currentAsset?.selectedImageId && createdImages[0]) {
      await prisma.$transaction([
        prisma.assetImage.updateMany({
          where: { assetId },
          data: { isSelected: false },
        }),
        prisma.assetImage.update({
          where: { id: createdImages[0].id },
          data: { isSelected: true },
        }),
        prisma.asset.update({
          where: { id: assetId },
          data: { selectedImageId: createdImages[0].id },
        }),
      ])
    }

    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.completed,
        completedAt: new Date(),
        progress: 100,
        error: null,
        payload: {
          ...taskPayloadState,
          imageProviderTasks: providerTasks,
          imageIds: createdImages.map((image) => image.id),
          mediaIds: createdImages.map((image) => image.mediaId),
          promptAdjusted: preparedPrompt.adjusted,
          removedPromptSegments: preparedPrompt.removedSegments,
          policyRetryUsed,
          policyFallbackUsed,
        },
      },
    })

    // BullMQ persists the processor return value as JSON. Prisma media records
    // contain BigInt fields, so return only the identifiers the queue needs.
    return {
      imageIds: createdImages.map((image) => image.id),
      mediaIds: createdImages.map((image) => image.mediaId),
    }
  } catch (error) {
    if (shouldDiscardImageProviderCheckpoint(error)) {
      await closeSubmittedProviderCheckpoints(error)
    }
    const unrecoverable = isUnrecoverableImageGenerationError(error)
    const willRetry = options.willRetryOnFailure === true && !unrecoverable
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: willRetry ? TaskStatus.queued : TaskStatus.failed,
        completedAt: willRetry ? null : new Date(),
        error: willRetry ? null : readableImageGenerationError(error),
        payload: taskPayloadState as Prisma.InputJsonObject,
      },
    })
    if (unrecoverable) {
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error))
    }
    throw error
  }
}
