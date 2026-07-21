import { GenerationTaskType, Prisma, TaskStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './db'
import { env } from './env'
import { HttpError } from './http'
import { enqueueTextGenerationTask, requeueTextGenerationTask } from './queue'
import { textTaskProgressDetail } from './text-task-progress'
import { reconcileTextTaskState } from './text-task-recovery'

export const saveNovelSchema = z.object({
  title: z.string().trim().min(1, '请填写作品名称').max(120),
  content: z.string().trim().min(100, '小说正文至少需要 100 个字').max(500_000, '当前版本单次最多处理 50 万字'),
})

export const adaptScriptSchema = z.object({
  targetEpisodeCount: z.coerce.number().int().min(1).max(60).default(15),
  episodeMinutes: z.coerce.number().min(0.5).max(10).multipleOf(0.5).default(1.5),
  replaceExisting: z.boolean().default(false),
})

export const updateScriptEpisodeSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  logline: z.string().trim().max(2000).optional().nullable(),
  content: z.string().trim().min(1).max(160_000).optional(),
  locked: z.boolean().optional(),
})

export const createScriptCommentSchema = z.object({
  quotedText: z.string().trim().min(1).max(6000),
  instruction: z.string().trim().min(1).max(3000),
  startOffset: z.number().int().min(0).optional().nullable(),
  endOffset: z.number().int().min(0).optional().nullable(),
}).superRefine((input, context) => {
  if (input.startOffset == null || input.endOffset == null) return
  if (input.endOffset <= input.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endOffset'], message: '选区范围无效' })
  }
})

export const extractAssetsSchema = z.object({
  refreshDrafts: z.boolean().default(true),
})

export const generateStoryboardsSchema = z.object({
  replaceExisting: z.boolean().default(false),
  lockEpisodes: z.boolean().default(false),
  episodeIds: z.array(z.string().trim().min(1)).min(1).max(60).optional(),
})

export const PREPRODUCTION_TASK_TYPES = [
  GenerationTaskType.script_adaptation,
  GenerationTaskType.script_revision,
  GenerationTaskType.asset_extraction,
  GenerationTaskType.storyboard_generation,
] as const

function serializeTask(task: {
  id: string
  type: GenerationTaskType
  status: TaskStatus
  model: string
  progress: number
  error: string | null
  projectId: string
  createdAt: Date
  updatedAt: Date
  payload: Prisma.JsonValue | null
}) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    model: task.model,
    progress: task.progress,
    error: task.error,
    projectId: task.projectId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    detail: textTaskProgressDetail(task.payload),
  }
}

function adaptationSettings(
  tasks: Array<{ type: GenerationTaskType; payload: Prisma.JsonValue | null }>,
  episodeCount: number,
) {
  const task = tasks.find((item) => item.type === GenerationTaskType.script_adaptation)
  const payload = task?.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
    ? task.payload as Record<string, unknown>
    : {}
  const requestedEpisodes = Number(payload.targetEpisodeCount)
  const requestedMinutes = Number(payload.episodeMinutes)
  return {
    targetEpisodeCount: Number.isFinite(requestedEpisodes)
      ? Math.max(1, Math.min(60, Math.round(requestedEpisodes)))
      : Math.max(1, Math.min(60, episodeCount || 15)),
    episodeMinutes: Number.isFinite(requestedMinutes)
      ? Math.max(0.5, Math.min(10, Math.round(requestedMinutes * 2) / 2))
      : 1.5,
    source: task ? 'task' as const : episodeCount > 0 ? 'episodes' as const : 'default' as const,
  }
}

export async function getPreproductionData(projectId: string) {
  const [novel, episodes, tasks] = await Promise.all([
    prisma.novelSource.findUnique({ where: { projectId } }),
    prisma.scriptEpisode.findMany({
      where: { projectId },
      include: {
        comments: {
          include: { createdBy: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { storyboards: true } },
      },
      orderBy: { episodeNumber: 'asc' },
    }),
    prisma.generationTask.findMany({
      where: { projectId, type: { in: [...PREPRODUCTION_TASK_TYPES] } },
      orderBy: { createdAt: 'desc' },
      take: 16,
    }),
  ])
  const latestTaskTypes = new Set<GenerationTaskType>()
  const reconciledTasks = await Promise.all(tasks.map((task) => {
    const autoRecoverFailed = !latestTaskTypes.has(task.type)
    latestTaskTypes.add(task.type)
    return reconcileTextTaskState(task, { autoRecoverFailed })
  }))

  return {
    novel: novel ? {
      id: novel.id,
      projectId: novel.projectId,
      title: novel.title,
      content: novel.content,
      updatedAt: novel.updatedAt.toISOString(),
    } : null,
    episodes: episodes.map((episode) => ({
      id: episode.id,
      projectId: episode.projectId,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      logline: episode.logline,
      content: episode.content,
      locked: episode.locked,
      sourceChunkIndexes: episode.sourceChunkIndexes,
      storyboardCount: episode._count.storyboards,
      updatedAt: episode.updatedAt.toISOString(),
      comments: episode.comments.map((comment) => ({
        id: comment.id,
        episodeId: comment.episodeId,
        quotedText: comment.quotedText,
        instruction: comment.instruction,
        startOffset: comment.startOffset,
        endOffset: comment.endOffset,
        resolved: comment.resolved,
        createdAt: comment.createdAt.toISOString(),
        createdBy: comment.createdBy,
      })),
    })),
    tasks: reconciledTasks.map(serializeTask),
    adaptationSettings: adaptationSettings(reconciledTasks, episodes.length),
    textModel: env.textModel(),
  }
}

export async function requireAllEpisodesLocked(projectId: string) {
  const episodes = await prisma.scriptEpisode.findMany({
    where: { projectId },
    select: { id: true, episodeNumber: true, locked: true },
    orderBy: { episodeNumber: 'asc' },
  })
  if (episodes.length === 0) {
    throw new HttpError(409, 'SCRIPT_REQUIRED', '请先完成小说改编，生成分集剧本')
  }
  const unlocked = episodes.filter((episode) => !episode.locked)
  if (unlocked.length > 0) {
    throw new HttpError(
      409,
      'SCRIPT_NOT_LOCKED',
      `请先审阅并锁定全部分集；尚未锁定：${unlocked.map((item) => `第 ${item.episodeNumber} 集`).join('、')}`,
    )
  }
  return episodes
}

export async function requireLockedEpisodes(projectId: string, requestedEpisodeIds?: string[]) {
  const episodes = await prisma.scriptEpisode.findMany({
    where: { projectId },
    select: { id: true, episodeNumber: true, locked: true },
    orderBy: { episodeNumber: 'asc' },
  })
  if (episodes.length === 0) {
    throw new HttpError(409, 'SCRIPT_REQUIRED', '请先完成小说改编，生成分集剧本')
  }

  const requestedIds = [...new Set(requestedEpisodeIds || [])]
  const selected = requestedIds.length > 0
    ? episodes.filter((episode) => requestedIds.includes(episode.id))
    : episodes.filter((episode) => episode.locked)
  if (requestedIds.length > 0 && selected.length !== requestedIds.length) {
    throw new HttpError(404, 'EPISODE_NOT_FOUND', '指定的分集不存在或不属于当前项目')
  }
  if (selected.length === 0) {
    throw new HttpError(409, 'SCRIPT_NOT_LOCKED', '请先审阅并锁定至少一集，再生成该集分镜')
  }

  const unlocked = selected.filter((episode) => !episode.locked)
  if (unlocked.length > 0) {
    throw new HttpError(
      409,
      'SCRIPT_NOT_LOCKED',
      `请先锁定所选分集：${unlocked.map((item) => `第 ${item.episodeNumber} 集`).join('、')}`,
    )
  }
  return selected
}

export async function requireAllEpisodesStoryboarded(projectId: string) {
  const episodes = await prisma.scriptEpisode.findMany({
    where: { projectId },
    select: {
      episodeNumber: true,
      _count: { select: { storyboards: true } },
    },
    orderBy: { episodeNumber: 'asc' },
  })
  if (episodes.length === 0) {
    throw new HttpError(409, 'SCRIPT_REQUIRED', '请先完成小说改编，生成分集剧本')
  }
  const missing = episodes.filter((episode) => episode._count.storyboards === 0)
  if (missing.length > 0) {
    throw new HttpError(
      409,
      'STORYBOARDS_REQUIRED',
      `请先完成全部分集的分镜拆解；尚未生成：${missing.map((item) => `第 ${item.episodeNumber} 集`).join('、')}`,
    )
  }
  return episodes
}

export async function createTextTask(input: {
  type: typeof PREPRODUCTION_TASK_TYPES[number]
  projectId: string
  createdById: string
  prompt: string
  payload?: Prisma.InputJsonObject
}) {
  const activeCandidate = await prisma.generationTask.findFirst({
    where: {
      projectId: input.projectId,
      type: input.type,
      status: { in: [TaskStatus.queued, TaskStatus.processing] },
    },
  })
  const active = activeCandidate ? await reconcileTextTaskState(activeCandidate) : null
  if (active) {
    if (active.status === TaskStatus.queued || active.status === TaskStatus.processing) {
      throw new HttpError(409, 'TASK_ALREADY_RUNNING', '同类型任务正在处理中，请等待完成')
    }
  }

  const failed = await prisma.generationTask.findFirst({
    where: {
      projectId: input.projectId,
      type: input.type,
      status: TaskStatus.failed,
    },
    orderBy: { updatedAt: 'desc' },
  })
  const failedPayload = failed?.payload && typeof failed.payload === 'object' && !Array.isArray(failed.payload)
    ? failed.payload as Record<string, unknown>
    : null
  const checkpointKey = input.type === GenerationTaskType.script_adaptation
    ? 'adaptationCheckpoint'
    : input.type === GenerationTaskType.asset_extraction
      ? 'assetExtractionCheckpoint'
      : input.type === GenerationTaskType.storyboard_generation
        ? 'storyboardCheckpoint'
        : null
  if (failed && failedPayload && checkpointKey && failedPayload[checkpointKey]) {
    const task = await prisma.generationTask.update({
      where: { id: failed.id },
      data: {
        status: TaskStatus.queued,
        model: env.textModel(),
        prompt: input.prompt,
        progress: Math.max(0, Math.min(99, failed.progress)),
        error: null,
        startedAt: null,
        completedAt: null,
        payload: {
          ...failedPayload,
          ...(input.payload || {}),
        } as Prisma.InputJsonObject,
      },
    })
    try {
      await requeueTextGenerationTask(task.id)
      return serializeTask(task)
    } catch (error) {
      await prisma.generationTask.update({
        where: { id: task.id },
        data: {
          status: TaskStatus.failed,
          completedAt: new Date(),
          error: 'TEXT_WORKER_INTERRUPTED: 无法重新加入后台队列，请稍后再次点击继续。',
        },
      })
      throw error
    }
  }

  const task = await prisma.generationTask.create({
    data: {
      type: input.type,
      status: TaskStatus.queued,
      projectId: input.projectId,
      createdById: input.createdById,
      provider: 'openai-compatible-text',
      model: env.textModel(),
      prompt: input.prompt,
      payload: input.payload,
    },
  })
  await enqueueTextGenerationTask(task.id)
  return serializeTask(task)
}
