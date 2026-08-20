import { BillingTaskType, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { resolveImageApiProviders, shouldFailoverImageApiError } from '@/lib/image-api-pool'
import { generateImageViaOpenAICompat, imageOutputToBuffer } from '@/lib/openai-image'
import { buildDirectorKeyframeStorageKey, uploadBuffer } from '@/lib/storage'

export async function processDirectorImageTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.directorImageTask.findUnique({
    where: { id: taskId },
    include: { keyframe: { include: { production: true } }, imageVersion: true },
  })
  if (!task) throw new Error(`DIRECTOR_IMAGE_TASK_NOT_FOUND: ${taskId}`)
  if (task.status === TaskStatus.completed) return task.imageVersion
  await prisma.directorImageTask.update({
    where: { id: task.id },
    data: { status: TaskStatus.processing, progress: 5, startedAt: task.startedAt || new Date(), error: null },
  })
  try {
    const providers = await resolveImageApiProviders({
      baseUrl: env.openAICompatBaseUrl(),
      model: task.model,
    })
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
          onRetry: async ({ attempt, maxAttempts, message }) => {
            await prisma.directorImageTask.update({
              where: { id: task.id },
              data: { progress: Math.min(70, 10 + attempt * 12), error: `${message}（${attempt}/${maxAttempts}）` },
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
      idempotencyKey: `director-image-task:${task.id}:image`,
      userId: task.createdById,
      taskType: BillingTaskType.image,
      sourceType: 'director_image_task',
      sourceTaskId: task.id,
      model: billedModel,
    })
    const image = await imageOutputToBuffer(generated)
    const storageKey = buildDirectorKeyframeStorageKey({
      productionId: task.keyframe.productionId,
      keyframeId: task.keyframeId,
      mimeType: image.mimeType,
    })
    await uploadBuffer({ key: storageKey, body: image.buffer, mimeType: image.mimeType })
    return await prisma.$transaction(async (tx) => {
      const media = await tx.mediaObject.create({
        data: { kind: 'image', storageKey, mimeType: image.mimeType, sizeBytes: BigInt(image.buffer.length) },
      })
      const aggregate = await tx.directorImageVersion.aggregate({
        where: { keyframeId: task.keyframeId }, _max: { version: true },
      })
      const version = await tx.directorImageVersion.create({
        data: {
          keyframeId: task.keyframeId,
          taskId: task.id,
          mediaId: media.id,
          version: (aggregate._max.version || 0) + 1,
          model: task.model,
          prompt: task.prompt,
        },
      })
      await tx.directorKeyframe.update({
        where: { id: task.keyframeId }, data: { selectedImageVersionId: version.id },
      })
      await tx.directorImageTask.update({
        where: { id: task.id },
        data: { status: TaskStatus.completed, progress: 100, completedAt: new Date(), error: null },
      })
      return version
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.directorImageTask.update({
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
