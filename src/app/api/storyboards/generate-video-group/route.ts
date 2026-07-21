import { AssetType, GenerationTaskType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { HttpError, routeHandler } from '@/lib/http'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import { enqueueVideoGenerationTask } from '@/lib/queue'
import {
  buildCombinedStoryboardVideoPrompt,
  buildStoryboardScriptSceneContext,
  generateStoryboardVideoGroupSchema,
  syncStoryboardAssetLinks,
} from '@/lib/storyboards'
import { fitVideoGroupDurations, orderSingleEpisodeVideoBatch } from '@/lib/video-batch'
import { resolveVideoModelDefinition } from '@/lib/video-models'

function payloadRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function taskStoryboardIds(task: { storyboardId: string | null, payload: unknown }) {
  const payload = payloadRecord(task.payload)
  const sourceIds = Array.isArray(payload.sourceStoryboardIds)
    ? payload.sourceStoryboardIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : []
  return sourceIds.length > 0 ? sourceIds : task.storyboardId ? [task.storyboardId] : []
}

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const body = generateStoryboardVideoGroupSchema.parse(await request.json())
    const first = await requireStoryboardAccess(body.storyboardIds[0], user.id)
    await requireWritableProject(first.projectId, user.id)

    await Promise.all(body.storyboardIds.map((storyboardId) => syncStoryboardAssetLinks(storyboardId)))
    const records = await prisma.storyboard.findMany({
      where: { id: { in: body.storyboardIds }, projectId: first.projectId },
      include: {
        project: true,
        episode: { select: { id: true, episodeNumber: true, title: true, content: true } },
        assetLinks: {
          include: {
            asset: {
              include: { selectedImage: { include: { media: true } } },
            },
          },
          orderBy: { referenceOrder: 'asc' },
        },
      },
    })
    if (records.length !== body.storyboardIds.length) {
      throw new HttpError(404, 'STORYBOARD_NOT_FOUND', '部分组合分镜不存在或不属于当前项目')
    }

    const storyboards = orderSingleEpisodeVideoBatch(records)
    const episodeId = storyboards[0]?.episodeId
    if (!episodeId || storyboards.some((storyboard) => storyboard.episodeId !== episodeId)) {
      throw new HttpError(422, 'VIDEO_GROUP_EPISODE_REQUIRED', '组合视频只能选择同一集内已经归档的分镜')
    }
    for (let index = 1; index < storyboards.length; index += 1) {
      const previous = storyboards[index - 1].episodeSceneNumber
      const current = storyboards[index].episodeSceneNumber
      if (!previous || !current || current !== previous + 1) {
        throw new HttpError(422, 'VIDEO_GROUP_NOT_CONTIGUOUS', '组合视频只能使用同一集内相邻的分镜')
      }
    }

    const sourceDuration = storyboards.reduce((total, storyboard) => total + storyboard.duration, 0)
    if (sourceDuration < 4) {
      throw new HttpError(422, 'VIDEO_GROUP_DURATION', `组合后的原始总时长不能少于 4 秒，当前为 ${sourceDuration} 秒`)
    }
    const aspectRatio = storyboards[0].aspectRatio
    if (storyboards.some((storyboard) => storyboard.aspectRatio !== aspectRatio)) {
      throw new HttpError(422, 'VIDEO_GROUP_ASPECT_RATIO', '组合分镜必须使用相同画幅')
    }
    if (storyboards.some((storyboard) => !storyboard.videoPrompt?.trim())) {
      throw new HttpError(422, 'VIDEO_GROUP_PROMPT_REQUIRED', '组合中的每个分镜都必须先保存视频提示词')
    }

    const requestedIds = new Set(storyboards.map((storyboard) => storyboard.id))
    const activeTasks = await prisma.generationTask.findMany({
      where: {
        projectId: first.projectId,
        type: GenerationTaskType.video_generation,
        status: { in: ['queued', 'processing'] },
      },
      select: { storyboardId: true, payload: true },
    })
    if (activeTasks.some((task) => taskStoryboardIds(task).some((id) => requestedIds.has(id)))) {
      throw new HttpError(409, 'VIDEO_GROUP_ACTIVE', '所选分镜中已有视频任务正在执行')
    }

    const references = new Map<string, (typeof storyboards)[number]['assetLinks'][number]>()
    for (const storyboard of storyboards) {
      for (const link of storyboard.assetLinks) {
        const isVideoReference = link.asset.type === AssetType.character || link.asset.type === AssetType.location
        if (isVideoReference && link.asset.selectedImage?.media && !references.has(link.assetId)) {
          references.set(link.assetId, link)
        }
      }
    }
    const referenceLinks = [...references.values()]
    if (referenceLinks.length === 0) {
      throw new HttpError(422, 'STORYBOARD_REFERENCE_REQUIRED', '组合分镜没有匹配到已设置主图的人物或场景')
    }
    if (referenceLinks.length > 4) {
      throw new HttpError(422, 'VIDEO_GROUP_REFERENCE_LIMIT', `组合分镜共需要 ${referenceLinks.length} 张人物或场景主图，视频模型最多支持 4 张，请减少组合数量`)
    }

    const model = body.model || env.videoModel() || 'seedance-2.0-mini'
    const modelDefinition = await resolveVideoModelDefinition(model)
    if (!modelDefinition) {
      throw new HttpError(400, 'VIDEO_MODEL_NOT_ALLOWED', '该模型当前不可用，请刷新模型列表后重新选择')
    }
    const fittedTimeline = fitVideoGroupDurations(
      storyboards.map((storyboard) => storyboard.duration),
      modelDefinition.maximumDuration,
    )
    const duration = fittedTimeline.duration
    if (duration < modelDefinition.minimumDuration || duration > modelDefinition.maximumDuration) {
      throw new HttpError(
        400,
        'VIDEO_DURATION_NOT_SUPPORTED',
        `当前模型只支持 ${modelDefinition.minimumDuration}–${modelDefinition.maximumDuration} 秒`,
      )
    }
    const resolution = body.resolution || modelDefinition.defaultResolution
    if (!modelDefinition.resolutions.includes(resolution)) {
      throw new HttpError(400, 'VIDEO_RESOLUTION_NOT_SUPPORTED', '当前视频模型不支持所选清晰度')
    }
    if (!modelDefinition.aspectRatios.some((supported) => supported === aspectRatio)) {
      throw new HttpError(400, 'VIDEO_ASPECT_RATIO_NOT_SUPPORTED', '当前视频模型不支持所选画幅')
    }

    const sourceStoryboardIds = storyboards.map((storyboard) => storyboard.id)
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: first.project.visualStyle,
      customStylePrompt: first.project.customStylePrompt,
      maxLength: /^(?:sd5-)?seedance-2\.0(?:-|$)/i.test(model) ? 4900 : 12000,
      aspectRatio,
      references: referenceLinks.map((link, index) => ({
        referenceOrder: index + 1,
        type: link.asset.type,
        name: link.asset.name,
      })),
      storyboards: storyboards.map((storyboard, index) => ({
        title: storyboard.title,
        duration: fittedTimeline.timelineDurations[index],
        videoPrompt: storyboard.videoPrompt || '',
        scriptSceneContext: buildStoryboardScriptSceneContext({
          script: storyboard.episode?.content,
          notes: storyboard.notes,
          locations: storyboard.assetLinks
            .filter((link) => link.asset.type === 'location')
            .map((link) => link.asset),
        }),
      })),
    })
    const generateAudio = modelDefinition.supportsAudio && (body.generateAudio
      ?? storyboards.some((storyboard) => storyboard.generateAudio))
    const anchor = storyboards[0]
    const task = await prisma.generationTask.create({
      data: {
        type: GenerationTaskType.video_generation,
        status: 'queued',
        projectId: anchor.projectId,
        storyboardId: anchor.id,
        createdById: user.id,
        provider: 'openai-compatible-video',
        model,
        prompt,
        requestedCount: 1,
        payload: {
          duration,
          sourceDuration,
          timelineDurations: fittedTimeline.timelineDurations,
          aspectRatio,
          resolution,
          generateAudio,
          model,
          sourceStoryboardIds,
          referenceAssetIds: referenceLinks.map((link) => link.assetId),
        },
      },
    })
    await enqueueVideoGenerationTask(task.id)

    return NextResponse.json({
      task: {
        id: task.id,
        type: task.type,
        status: task.status,
        progress: task.progress,
        model: task.model,
        projectId: task.projectId,
        storyboardId: anchor.id,
        sourceStoryboardIds,
        error: task.error,
        createdAt: task.createdAt.toISOString(),
      },
    }, { status: 202 })
  })
}
