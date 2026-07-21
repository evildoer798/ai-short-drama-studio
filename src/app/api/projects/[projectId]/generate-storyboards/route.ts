import { GenerationTaskType, Prisma, TaskStatus } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import {
  createTextTask,
  generateStoryboardsSchema,
  requireLockedEpisodes,
} from '@/lib/preproduction'

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = generateStoryboardsSchema.parse(await request.json().catch(() => ({})))
    if (body.lockEpisodes) {
      await prisma.scriptEpisode.updateMany({
        where: { projectId, locked: false },
        data: { locked: true },
      })
    }
    const targetEpisodes = await requireLockedEpisodes(projectId, body.episodeIds)
    const targetEpisodeIds = targetEpisodes.map((episode) => episode.id)
    const [generatedStoryboards, latestFailedTask] = await Promise.all([
      prisma.storyboard.findMany({
        where: {
          projectId,
          episodeId: { in: targetEpisodeIds },
          generatedByAI: true,
        },
        select: { id: true },
      }),
      prisma.generationTask.findFirst({
        where: {
          projectId,
          type: GenerationTaskType.storyboard_generation,
          status: TaskStatus.failed,
        },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      }),
    ])
    if (generatedStoryboards.length > 0 && !body.replaceExisting) {
      throw new HttpError(
        409,
        'STORYBOARDS_EXIST',
        `${targetEpisodes.map((episode) => `第 ${episode.episodeNumber} 集`).join('、')}已有 AI 分镜，请确认只替换所选分集后再重新拆解`,
      )
    }
    const failedPayload = latestFailedTask?.payload
      && typeof latestFailedTask.payload === 'object'
      && !Array.isArray(latestFailedTask.payload)
      ? latestFailedTask.payload as Prisma.JsonObject
      : null
    const previousCheckpoint = failedPayload?.storyboardCheckpoint
    const taskPayload: Prisma.InputJsonObject = {
      ...body,
      episodeIds: targetEpisodeIds,
      ...(previousCheckpoint && typeof previousCheckpoint === 'object' && !Array.isArray(previousCheckpoint)
        ? { storyboardCheckpoint: previousCheckpoint as Prisma.InputJsonObject }
        : {}),
    }
    const task = await createTextTask({
      type: GenerationTaskType.storyboard_generation,
      projectId,
      createdById: user.id,
      prompt: `把${targetEpisodes.map((episode) => `第 ${episode.episodeNumber} 集`).join('、')}已锁定剧本拆解为电影级视频分镜`,
      payload: taskPayload,
    })
    return NextResponse.json({ task }, { status: 202 })
  })
}
