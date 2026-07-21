import { GenerationTaskType, Prisma, TaskStatus, type GenerationTask } from '@prisma/client'
import { prisma } from './db'
import { getTextQueue, requeueTextGenerationTask } from './queue'

const TEXT_TASK_TYPES = new Set<GenerationTaskType>([
  GenerationTaskType.script_adaptation,
  GenerationTaskType.script_revision,
  GenerationTaskType.asset_extraction,
  GenerationTaskType.storyboard_generation,
])

const ACTIVE_QUEUE_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])
export const TEXT_TASK_STALE_AFTER_MS = 2 * 60_000
export const TEXT_TASK_AUTO_RECOVERY_LIMIT = 5

type RecoveryPayload = Record<string, unknown> & {
  textAutoRecovery?: {
    attempts?: number
    lastRecoveredAt?: string
  }
}

function payloadRecord(value: unknown): RecoveryPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as RecoveryPayload) }
    : {}
}

function recoveryAttempts(payload: unknown) {
  const attempts = payloadRecord(payload).textAutoRecovery?.attempts
  return typeof attempts === 'number' && Number.isFinite(attempts)
    ? Math.max(0, Math.round(attempts))
    : 0
}

export function isRecoverableTextTaskFailure(error: string | null) {
  if (!error) return true
  if (/TEXT_API_FAILED:\s*(401|402|403)|PROJECT_NOT_FOUND|项目不存在|SCENE_CONSISTENCY_MISSING/i.test(error)) {
    return false
  }
  return /TEXT_|SCENE_CONSISTENCY_MISMATCH|timeout|timed?\s*out|aborted|fetch|socket|ECONN|ENOTFOUND|429|502|503|504|模型|文本 API|JSON|队列|网关|内容审核|moderation/i.test(error)
}

export function canAutoRecoverTextTask(input: {
  status: TaskStatus
  error: string | null
  payload: unknown
}) {
  return input.status === TaskStatus.failed
    && isRecoverableTextTaskFailure(input.error)
    && recoveryAttempts(input.payload) < TEXT_TASK_AUTO_RECOVERY_LIMIT
}

async function autoRecoverFailedTextTask<T extends GenerationTask>(task: T): Promise<T> {
  if (!canAutoRecoverTextTask(task)) return task
  const attempts = recoveryAttempts(task.payload) + 1
  const payload = payloadRecord(task.payload)
  const nextPayload = {
    ...payload,
    textAutoRecovery: {
      attempts,
      lastRecoveredAt: new Date().toISOString(),
    },
  } as Prisma.InputJsonObject
  const claimed = await prisma.generationTask.updateMany({
    where: { id: task.id, status: TaskStatus.failed },
    data: {
      status: TaskStatus.queued,
      completedAt: null,
      error: null,
      payload: nextPayload,
    },
  })
  if (claimed.count === 0) {
    return (await prisma.generationTask.findUnique({ where: { id: task.id } }) || task) as T
  }

  try {
    await requeueTextGenerationTask(task.id)
    return {
      ...task,
      status: TaskStatus.queued,
      completedAt: null,
      error: null,
      payload: nextPayload,
    } as T
  } catch {
    await prisma.generationTask.updateMany({
      where: { id: task.id, status: TaskStatus.queued },
      data: {
        status: TaskStatus.failed,
        completedAt: new Date(),
        error: task.error,
        payload: task.payload ?? Prisma.JsonNull,
      },
    })
    return task
  }
}

export function shouldMarkTextTaskInterrupted(input: {
  status: TaskStatus
  updatedAt: Date
  queueState: string
  now?: number
}) {
  if (input.status !== TaskStatus.queued && input.status !== TaskStatus.processing) return false
  if ((input.now ?? Date.now()) - input.updatedAt.getTime() < TEXT_TASK_STALE_AFTER_MS) return false
  return !ACTIVE_QUEUE_STATES.has(input.queueState)
}

export async function reconcileTextTaskState<T extends GenerationTask>(
  task: T,
  options: { autoRecoverFailed?: boolean } = {},
): Promise<T> {
  if (!TEXT_TASK_TYPES.has(task.type)) return task
  if (task.status === TaskStatus.failed) {
    return options.autoRecoverFailed ? autoRecoverFailedTextTask(task) : task
  }
  if (task.status !== TaskStatus.queued && task.status !== TaskStatus.processing) return task

  try {
    const job = await getTextQueue().getJob(task.id)
    const queueState = job ? await job.getState() : 'missing'
    if (!shouldMarkTextTaskInterrupted({
      status: task.status,
      updatedAt: task.updatedAt,
      queueState,
    })) return task

    const updated = await prisma.generationTask.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.failed,
        completedAt: new Date(),
        error: 'TEXT_TASK_INTERRUPTED: 后台文字任务已经停止，系统正在从已保存的检查点自动续跑。',
      },
    })
    return options.autoRecoverFailed
      ? autoRecoverFailedTextTask({ ...task, ...updated })
      : { ...task, ...updated }
  } catch {
    // Redis being temporarily unavailable must not incorrectly fail a database task.
    return task
  }
}
