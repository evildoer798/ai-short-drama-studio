import { BillingTaskType, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { resolveImageApiProviders, shouldFailoverImageApiError } from '@/lib/image-api-pool'
import { generateImageViaOpenAICompat, imageOutputToBuffer } from '@/lib/openai-image'
import { buildDirectorStateAssetStorageKey, downloadBuffer, uploadBuffer } from '@/lib/storage'
import {
  identityMasterStateId,
  identityMasterVersionIdFromPayload,
  isIdentityMasterStateId,
} from '@/lib/director-state-assets'

export async function processDirectorStateImageTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.directorStateImageTask.findUnique({
    where: { id: taskId },
    include: { stateAsset: { include: { production: true } }, imageVersion: true },
  })
  if (!task) throw new Error(`DIRECTOR_STATE_IMAGE_TASK_NOT_FOUND: ${taskId}`)
  if (task.status === TaskStatus.completed) return task.imageVersion
  await prisma.directorStateImageTask.update({
    where: { id: task.id },
    data: { status: TaskStatus.processing, progress: 5, startedAt: task.startedAt || new Date(), error: null },
  })
  try {
    const references = task.referenceMediaIds.length
      ? await prisma.mediaObject.findMany({ where: { id: { in: task.referenceMediaIds }, mimeType: { startsWith: 'image/' } } })
      : []
    const byId = new Map(references.map((media) => [media.id, media]))
    const ordered = task.referenceMediaIds.map((id) => byId.get(id))
    if (ordered.some((media) => !media)) throw new Error('IMAGE_REFERENCE_REQUIRED: 角色身份参考图不可用')
    const referenceImages = await Promise.all(ordered.map(async (media) => {
      const bytes = await downloadBuffer(media!.storageKey)
      return { dataUrl: `data:${media!.mimeType};base64,${bytes.toString('base64')}` }
    }))
    const providers = await resolveImageApiProviders({ baseUrl: env.openAICompatBaseUrl(), model: task.model })
    let generated: Awaited<ReturnType<typeof generateImageViaOpenAICompat>> | null = null
    let billedModel = task.model
    let lastError: unknown = null
    for (let index = 0; index < providers.length; index++) {
      const provider = providers[index]
      try {
        generated = await generateImageViaOpenAICompat({
          prompt: task.prompt,
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
          referenceImages,
          onRetry: async ({ attempt, maxAttempts, message }) => {
            await prisma.directorStateImageTask.update({
              where: { id: task.id },
              data: { progress: Math.min(75, 10 + attempt * 12), error: `${message}（${attempt}/${maxAttempts}）` },
            })
          },
        })
        billedModel = provider.model
        break
      } catch (error) {
        lastError = error
        if (index === providers.length - 1 || !shouldFailoverImageApiError(error)) throw error
      }
    }
    if (!generated) throw lastError || new Error('IMAGE_API_POOL_UNAVAILABLE')
    await recordCompletedUsage({
      idempotencyKey: `director-state-image-task:${task.id}:image`,
      userId: task.createdById,
      taskType: BillingTaskType.image,
      sourceType: 'director_state_image_task',
      sourceTaskId: task.id,
      model: billedModel,
    })
    const image = await imageOutputToBuffer(generated)
    const storageKey = buildDirectorStateAssetStorageKey({
      productionId: task.stateAsset.productionId,
      stateAssetId: task.stateAssetId,
      mimeType: image.mimeType,
    })
    await uploadBuffer({ key: storageKey, body: image.buffer, mimeType: image.mimeType })
    return await prisma.$transaction(async (tx) => {
      const media = await tx.mediaObject.create({
        data: { kind: 'image', storageKey, mimeType: image.mimeType, sizeBytes: BigInt(image.buffer.length) },
      })
      const aggregate = await tx.directorStateImageVersion.aggregate({
        where: { stateAssetId: task.stateAssetId }, _max: { version: true },
      })
      const version = await tx.directorStateImageVersion.create({
        data: {
          stateAssetId: task.stateAssetId,
          taskId: task.id,
          mediaId: media.id,
          version: (aggregate._max.version || 0) + 1,
          model: task.model,
          prompt: task.prompt,
        },
      })
      const isIdentityMaster = isIdentityMasterStateId(task.stateAsset.stateId)
      if (isIdentityMaster) {
        await tx.directorCharacterStateAsset.update({
          where: { id: task.stateAssetId }, data: { selectedImageVersionId: version.id },
        })
        await tx.directorCharacterStateAsset.updateMany({
          where: {
            productionId: task.stateAsset.productionId,
            assetId: task.stateAsset.assetId,
            stateId: { not: task.stateAsset.stateId },
          },
          data: { selectedImageVersionId: null },
        })
      } else {
        const identityMaster = await tx.directorCharacterStateAsset.findUnique({
          where: {
            productionId_stateId: {
              productionId: task.stateAsset.productionId,
              stateId: identityMasterStateId(task.stateAsset.assetId),
            },
          },
          select: { selectedImageVersionId: true },
        })
        if (
          !identityMaster?.selectedImageVersionId
          || identityMasterVersionIdFromPayload(task.payload) !== identityMaster.selectedImageVersionId
        ) {
          throw new Error('DIRECTOR_IDENTITY_MASTER_CHANGED: 初始形象已更换，请基于当前母版重新生成状态图')
        }
        await tx.directorCharacterStateAsset.update({
          where: { id: task.stateAssetId }, data: { selectedImageVersionId: version.id },
        })
      }
      await tx.directorStateImageTask.update({
        where: { id: task.id },
        data: { status: TaskStatus.completed, progress: 100, completedAt: new Date(), error: null },
      })
      return version
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.directorStateImageTask.update({
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
