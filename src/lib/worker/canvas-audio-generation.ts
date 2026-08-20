import { BillingTaskType, CanvasNodeType, Prisma, TaskStatus } from '@prisma/client'
import { recordCompletedUsage } from '@/lib/billing'
import {
  readableCanvasAudioError,
  retrieveCangyuanAudioGeneration,
  submitCangyuanAudioGeneration,
} from '@/lib/cangyuan-audio'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { buildCanvasStorageKey, deleteStorageObject, uploadBuffer } from '@/lib/storage'

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function payloadRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

export async function processCanvasAudioTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  let pendingStorageKey: string | null = null
  const task = await prisma.canvasAudioTask.findUnique({
    where: { id: taskId },
    include: { node: { include: { media: true } }, canvas: true },
  })
  if (!task || task.node.type !== CanvasNodeType.audio) {
    throw new Error(`Canvas audio task or node not found: ${taskId}`)
  }
  const payload = payloadRecord(task.payload)
  if (task.status === TaskStatus.completed) return payload

  await prisma.canvasAudioTask.update({
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
    const config = { baseUrl: env.audioApiBaseUrl(), apiKey: env.audioApiKey() }
    const submitted = task.providerJobId
      ? await retrieveCangyuanAudioGeneration(config, task.providerJobId)
      : await submitCangyuanAudioGeneration(config, { model: task.model, prompt: task.prompt })
    payload.providerJobId = submitted.id
    await prisma.canvasAudioTask.update({
      where: { id: task.id },
      data: {
        providerJobId: submitted.id,
        progress: submitted.status === 'completed' ? 92 : 8,
        payload: payload as Prisma.InputJsonObject,
      },
    })

    let current = submitted
    const startedPollingAt = Date.now()
    const deadline = Date.now() + 10 * 60_000
    while (!['completed', 'failed'].includes(current.status)) {
      if (Date.now() > deadline) throw new Error(`AUDIO_TASK_TIMEOUT: ${submitted.id}`)
      await sleep(7_000)
      current = await retrieveCangyuanAudioGeneration(config, submitted.id)
      const progress = Math.min(90, 10 + Math.floor((Date.now() - startedPollingAt) / 8_000) * 4)
      await prisma.canvasAudioTask.update({ where: { id: task.id }, data: { progress } })
    }
    if (current.status !== 'completed') {
      throw new Error(`AUDIO_TASK_FAILED: ${current.error || JSON.stringify(current.raw)}`)
    }
    if (!current.url) throw new Error(`AUDIO_RESULT_URL_MISSING: ${submitted.id}`)

    await recordCompletedUsage({
      idempotencyKey: `canvas-audio-task:${task.id}:audio`,
      userId: task.createdById,
      taskType: BillingTaskType.audio,
      sourceType: 'canvas_audio_task',
      sourceTaskId: task.id,
      model: task.model,
      quantity: 1,
    })

    const response = await fetch(current.url, { signal: AbortSignal.timeout(90_000) })
    if (!response.ok) throw new Error(`AUDIO_DOWNLOAD_FAILED: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength < 128) throw new Error(`AUDIO_DOWNLOAD_EMPTY: ${bytes.byteLength} bytes`)
    const responseType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const mimeType = responseType === 'video/mp4'
      ? 'audio/mp4'
      : responseType?.startsWith('audio/')
        ? responseType
      : 'audio/mpeg'
    const storageKey = buildCanvasStorageKey({ canvasId: task.canvasId, nodeId: task.nodeId, mimeType })
    await uploadBuffer({ key: storageKey, body: bytes, mimeType })
    pendingStorageKey = storageKey

    const media = await prisma.$transaction(async (tx) => {
      const created = await tx.mediaObject.create({
        data: {
          kind: 'audio',
          storageKey,
          mimeType,
          sizeBytes: BigInt(bytes.byteLength),
        },
      })
      await tx.canvasNode.update({ where: { id: task.nodeId }, data: { mediaId: created.id } })
      await tx.canvasAudioTask.update({
        where: { id: task.id },
        data: {
          mediaId: created.id,
          status: TaskStatus.completed,
          progress: 100,
          completedAt: new Date(),
          error: null,
          payload: { ...payload, resultMediaId: created.id, resultUrl: current.url } as Prisma.InputJsonObject,
        },
      })
      await tx.creativeCanvas.update({ where: { id: task.canvasId }, data: { updatedAt: new Date() } })
      if (task.node.mediaId) await tx.mediaObject.delete({ where: { id: task.node.mediaId } })
      return created
    })
    if (task.node.media?.storageKey) await deleteStorageObject(task.node.media.storageKey).catch(() => undefined)
    pendingStorageKey = null
    return { taskId: task.id, mediaId: media.id }
  } catch (error) {
    if (pendingStorageKey) await deleteStorageObject(pendingStorageKey).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    const willRetry = options.willRetryOnFailure === true
    const resetProviderJob = willRetry && message.includes('AUDIO_TASK_FAILED')
    payload.providerError = message.slice(0, 8_000)
    if (resetProviderJob) payload.providerJobId = null
    await prisma.canvasAudioTask.update({
      where: { id: task.id },
      data: {
        status: willRetry ? TaskStatus.queued : TaskStatus.failed,
        progress: willRetry ? 3 : undefined,
        providerJobId: resetProviderJob ? null : undefined,
        completedAt: willRetry ? null : new Date(),
        error: willRetry ? null : readableCanvasAudioError(message),
        payload: payload as Prisma.InputJsonObject,
      },
    })
    throw error
  }
}
