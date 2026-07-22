import { NextRequest, NextResponse } from 'next/server'
import { AssetType, GenerationTaskType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import { env } from '@/lib/env'
import { enqueueVideoGenerationTask } from '@/lib/queue'
import {
  buildStoryboardScriptSceneContext,
  buildStoryboardVideoPrompt,
  generateStoryboardVideoSchema,
  syncStoryboardAssetLinks,
} from '@/lib/storyboards'
import { resolveVideoModelDefinition } from '@/lib/video-models'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const current = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(current.projectId, user.id)
    const body = generateStoryboardVideoSchema.parse(await request.json())

    const activeTask = await prisma.generationTask.findFirst({
      where: {
        storyboardId,
        type: GenerationTaskType.video_generation,
        status: { in: ['queued', 'processing'] },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (activeTask) {
      const activePayload = activeTask.payload && typeof activeTask.payload === 'object' && !Array.isArray(activeTask.payload)
        ? activeTask.payload as Record<string, unknown>
        : {}
      const sourceStoryboardIds = Array.isArray(activePayload.sourceStoryboardIds)
        ? activePayload.sourceStoryboardIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : [storyboardId]
      return NextResponse.json({
        reused: true,
        task: {
          id: activeTask.id,
          type: activeTask.type,
          status: activeTask.status,
          progress: activeTask.progress,
          model: activeTask.model,
          projectId: activeTask.projectId,
          storyboardId: activeTask.storyboardId,
          sourceStoryboardIds,
          error: activeTask.error,
          createdAt: activeTask.createdAt.toISOString(),
        },
      }, { status: 202 })
    }

    await syncStoryboardAssetLinks(storyboardId)
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    const duration = body.duration ?? storyboard.duration
    const aspectRatio = body.aspectRatio ?? storyboard.aspectRatio
    const generateAudio = body.generateAudio ?? storyboard.generateAudio
    const model = body.model || env.videoModel() || 'seedance-2.0-mini'
    const modelDefinition = await resolveVideoModelDefinition(model)
    if (!modelDefinition) {
      throw new HttpError(400, 'VIDEO_MODEL_NOT_ALLOWED', '该模型当前不可用，请刷新模型列表后重新选择')
    }
    const matchedAssets = storyboard.assetLinks
    const references = matchedAssets
      .filter((link) => (
        (link.asset.type === AssetType.character || link.asset.type === AssetType.location)
        && link.asset.selectedImage?.media
      ))
      .slice(0, modelDefinition.maximumReferenceImages)

    if (references.length === 0) {
      const missing = matchedAssets.map((link) => link.asset.name).join('、')
      throw new HttpError(
        422,
        'STORYBOARD_REFERENCE_REQUIRED',
        missing
          ? `已识别资产但尚未设置主图：${missing}`
          : '分镜提示词未识别到资产，请在资产名称或标签中使用与分镜一致的名称',
      )
    }
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
    const prompt = buildStoryboardVideoPrompt({
      title: storyboard.title,
      videoPrompt: storyboard.videoPrompt || '',
      scriptSceneContext: buildStoryboardScriptSceneContext({
        script: storyboard.episode?.content,
        notes: storyboard.notes,
        locations: matchedAssets
          .filter((link) => link.asset.type === 'location')
          .map((link) => link.asset),
      }),
      visualStyle: storyboard.project.visualStyle,
      customStylePrompt: storyboard.project.customStylePrompt,
      maxLength: /^(?:sd5-)?seedance-2\.0(?:-|$)/i.test(model) ? 4900 : 12000,
      duration,
      aspectRatio,
      references: references.map((link) => ({
        referenceOrder: link.referenceOrder,
        type: link.asset.type,
        name: link.asset.name,
      })),
    })
    if (/^(?:sd5-)?seedance-2\.0(?:-|$)/i.test(model) && prompt.length > 5000) {
      throw new HttpError(422, 'VIDEO_PROMPT_TOO_LONG', `Seedance 提示词最多 5000 字符，当前为 ${prompt.length} 字符`)
    }

    const task = await prisma.generationTask.create({
      data: {
        type: GenerationTaskType.video_generation,
        status: 'queued',
        projectId: storyboard.projectId,
        storyboardId: storyboard.id,
        createdById: user.id,
        provider: 'openai-compatible-video',
        model,
        prompt,
        requestedCount: 1,
        payload: {
          duration,
          aspectRatio,
          resolution,
          generateAudio: modelDefinition.supportsAudio && generateAudio,
          model,
          sourceStoryboardIds: [storyboard.id],
          referenceAssetIds: references.map((link) => link.assetId),
        },
      },
    })

    await enqueueVideoGenerationTask(task.id)

    return NextResponse.json({
      reused: false,
      task: {
        id: task.id,
        type: task.type,
        status: task.status,
        progress: task.progress,
        model: task.model,
        projectId: task.projectId,
        storyboardId: storyboard.id,
        sourceStoryboardIds: [storyboard.id],
        error: task.error,
        createdAt: task.createdAt.toISOString(),
      },
    }, { status: 202 })
  })
}
