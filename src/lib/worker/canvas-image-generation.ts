import { BillingTaskType, CanvasNodeType, Prisma, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { canvasImageSize } from '@/lib/creative-canvas'
import { resolveImageApiProviders, shouldFailoverImageApiError } from '@/lib/image-api-pool'
import { generateImageViaOpenAICompat, imageOutputToBuffer } from '@/lib/openai-image'
import {
  buildCanvasStorageKey,
  deleteStorageObject,
  downloadBuffer,
  uploadBuffer,
} from '@/lib/storage'

function payloadRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function readableCanvasImageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/CONTENT_POLICY|SAFETY|MODERATION|PROMPT_BLOCKED/iu.test(message)) return '提示词或参考图未通过图片生成安全检查，请调整后重试。'
  if (/403|NO ACCESS|PERMISSION|无权限/iu.test(message)) return '当前图片 API Key 没有所选模型权限，请更换模型或检查授权。'
  if (/REFERENCE|INPUT_IMAGE|IMAGE_URL/iu.test(message)) return '参考图未被当前模型接受，请减少参考图或更换支持参考图的模型。'
  return message.slice(0, 8000) || '图片生成失败'
}

export async function processCanvasImageTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const pendingStorageKeys: string[] = []
  const task = await prisma.canvasImageTask.findUnique({
    where: { id: taskId },
    include: { node: { include: { media: true } } },
  })
  if (!task || task.node.type !== CanvasNodeType.image || !task.node.model) {
    throw new Error(`CANVAS_IMAGE_TASK_NOT_FOUND: ${taskId}`)
  }
  if (task.status === TaskStatus.completed) return { taskId: task.id, mediaId: task.mediaId }
  const payload = payloadRecord(task.payload)
  await prisma.canvasImageTask.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.processing,
      progress: Math.max(3, task.progress),
      startedAt: task.startedAt || new Date(),
      completedAt: null,
      error: null,
    },
  })

  try {
    const references = task.referenceNodeIds.length > 0
      ? await prisma.canvasNode.findMany({
          where: { id: { in: task.referenceNodeIds }, canvasId: task.canvasId, type: CanvasNodeType.image },
          include: { media: true },
        })
      : []
    const referenceById = new Map(references.map((node) => [node.id, node]))
    const orderedReferences = task.referenceNodeIds.map((nodeId) => referenceById.get(nodeId))
    if (orderedReferences.some((node) => !node?.media?.mimeType.startsWith('image/'))) {
      throw new Error('IMAGE_REFERENCE_REQUIRED: 连线图片已被删除或不可用')
    }
    const referenceImages = await Promise.all(orderedReferences.map(async (node) => {
      const bytes = await downloadBuffer(node!.media!.storageKey)
      return { dataUrl: `data:${node!.media!.mimeType};base64,${bytes.toString('base64')}` }
    }))
    const providers = await resolveImageApiProviders({
      baseUrl: env.openAICompatBaseUrl(),
      model: task.model,
    })
    const dimensions = canvasImageSize(task.aspectRatio, task.resolution)
    const outputs: Array<{ buffer: Buffer, mimeType: string }> = []
    for (let outputIndex = 0; outputIndex < task.count; outputIndex++) {
      let generated: Awaited<ReturnType<typeof generateImageViaOpenAICompat>> | null = null
      let billedModel = task.model
      let lastError: unknown = null
      for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
        const provider = providers[providerIndex]
        try {
          generated = await generateImageViaOpenAICompat({
            prompt: task.prompt,
            model: provider.model,
            baseUrl: env.openAICompatBaseUrl(),
            apiKey: provider.apiKey,
            mode: env.imageApiMode(),
            quality: env.imageQuality(),
            size: dimensions.size,
            outputFormat: env.imageOutputFormat(),
            outputCompression: env.imageOutputCompression(),
            partialImages: env.imagePartialImages(),
            stream: env.imageStream(),
            useAsync: env.imageAsync(),
            providerTimeoutRetries: env.imageProviderTimeoutRetries(),
            referenceImages,
            onRetry: async ({ attempt, maxAttempts, message }) => {
              await prisma.canvasImageTask.update({
                where: { id: task.id },
                data: {
                  progress: Math.min(88, Math.round((outputIndex + attempt / maxAttempts) / task.count * 82)),
                  error: `${message}（${attempt}/${maxAttempts}）`,
                },
              })
            },
          })
          billedModel = provider.model
          break
        } catch (error) {
          lastError = error
          if (providerIndex === providers.length - 1 || !shouldFailoverImageApiError(error)) throw error
        }
      }
      if (!generated) throw lastError || new Error('IMAGE_API_POOL_UNAVAILABLE')
      await recordCompletedUsage({
        idempotencyKey: `canvas-image-task:${task.id}:image:${outputIndex}`,
        userId: task.createdById,
        taskType: BillingTaskType.image,
        sourceType: 'canvas_image_task',
        sourceTaskId: task.id,
        model: billedModel,
      })
      outputs.push(await imageOutputToBuffer(generated))
      await prisma.canvasImageTask.update({
        where: { id: task.id },
        data: { progress: Math.min(92, Math.round((outputIndex + 1) / task.count * 90)) },
      })
    }

    const stored = [] as Array<{ storageKey: string, buffer: Buffer, mimeType: string }>
    for (const output of outputs) {
      const storageKey = buildCanvasStorageKey({ canvasId: task.canvasId, nodeId: task.nodeId, mimeType: output.mimeType })
      await uploadBuffer({ key: storageKey, body: output.buffer, mimeType: output.mimeType })
      pendingStorageKeys.push(storageKey)
      stored.push({ storageKey, ...output })
    }

    const result = await prisma.$transaction(async (tx) => {
      const mediaIds: string[] = []
      for (let index = 0; index < stored.length; index++) {
        const output = stored[index]
        const media = await tx.mediaObject.create({
          data: {
            kind: 'image',
            storageKey: output.storageKey,
            mimeType: output.mimeType,
            sizeBytes: BigInt(output.buffer.length),
            width: dimensions.width,
            height: dimensions.height,
          },
        })
        mediaIds.push(media.id)
        if (index === 0) {
          await tx.canvasNode.update({ where: { id: task.nodeId }, data: { mediaId: media.id } })
        } else {
          await tx.canvasNode.create({
            data: {
              canvasId: task.canvasId,
              type: CanvasNodeType.image,
              title: `${task.node.title} ${index + 1}`,
              positionX: task.node.positionX + 430 * index,
              positionY: task.node.positionY,
              width: 320,
              height: 280,
              mediaId: media.id,
              aspectRatio: task.aspectRatio,
              resolution: task.resolution,
              generateAudio: false,
            },
          })
        }
      }
      await tx.canvasImageTask.update({
        where: { id: task.id },
        data: {
          mediaId: mediaIds[0],
          status: TaskStatus.completed,
          progress: 100,
          completedAt: new Date(),
          error: null,
          payload: { ...payload, resultMediaIds: mediaIds } as Prisma.InputJsonObject,
        },
      })
      await tx.creativeCanvas.update({ where: { id: task.canvasId }, data: { updatedAt: new Date() } })
      if (task.node.mediaId) await tx.mediaObject.delete({ where: { id: task.node.mediaId } })
      return mediaIds
    })
    pendingStorageKeys.length = 0
    if (task.node.media?.storageKey) await deleteStorageObject(task.node.media.storageKey).catch(() => undefined)
    return { taskId: task.id, mediaId: result[0], mediaIds: result }
  } catch (error) {
    await Promise.all(pendingStorageKeys.map((key) => deleteStorageObject(key).catch(() => undefined)))
    const willRetry = options.willRetryOnFailure === true
    await prisma.canvasImageTask.update({
      where: { id: task.id },
      data: {
        status: willRetry ? TaskStatus.queued : TaskStatus.failed,
        progress: willRetry ? 3 : undefined,
        completedAt: willRetry ? null : new Date(),
        error: willRetry ? null : readableCanvasImageError(error),
      },
    })
    throw error
  }
}
