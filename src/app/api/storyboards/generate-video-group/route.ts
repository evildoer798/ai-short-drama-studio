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
  isExcludedStoryboardAssetLink,
  prioritizeCombinedStoryboardReferences,
  syncStoryboardAssetLinks,
} from '@/lib/storyboards'
import { fitVideoGroupDurations, orderSingleEpisodeVideoBatch } from '@/lib/video-batch'
import { resolveVideoModelDefinition, videoModelPromptBudget } from '@/lib/video-models'
import { DEFAULT_VIDEO_MODEL_ID } from '@/lib/video-defaults'
import { getCompilableStoryboardPerformances } from '@/lib/acting-data'
import { appendShotPerformancePrompt, compileShotPerformancePrompt } from '@/lib/acting-system'
import {
  planVideoReferences,
  REFERENCE_MONTAGE_IMAGES_PER_VIDEO,
  referenceMontagePrompt,
} from '@/lib/video-reference-plan'

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

function assetPromptMentionCount(value: string, assetName: string) {
  const plainName = assetName.replace(/[（(【\[].*$/u, '').trim()
  if (!plainName) return 0
  return value.split(plainName).length - 1
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
      throw new HttpError(
        422,
        'VIDEO_GROUP_DURATION',
        `组合分镜原始总时长不能少于 4 秒，当前为 ${sourceDuration} 秒`,
      )
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

    const model = body.model || env.videoModel() || DEFAULT_VIDEO_MODEL_ID
    const modelDefinition = await resolveVideoModelDefinition(model)
    if (!modelDefinition) {
      throw new HttpError(400, 'VIDEO_MODEL_NOT_ALLOWED', '该模型当前不可用，请刷新模型列表后重新选择')
    }
    if (sourceDuration > modelDefinition.maximumDuration) {
      throw new HttpError(
        422,
        'VIDEO_GROUP_DURATION',
        `所选分镜共 ${sourceDuration} 秒，当前模型最多支持 ${modelDefinition.maximumDuration} 秒`,
      )
    }

    const references = new Map<string, {
      link: (typeof storyboards)[number]['assetLinks'][number]
      storyboardIndexes: Set<number>
      mentionCount: number
      appearsInFinalStoryboard: boolean
    }>()
    for (const [storyboardIndex, storyboard] of storyboards.entries()) {
      for (const link of storyboard.assetLinks) {
        if (isExcludedStoryboardAssetLink(link.matchReason)) continue
        const isVideoReference = link.asset.type === AssetType.character
          || link.asset.type === AssetType.location
          || link.asset.type === AssetType.prop
        if (!isVideoReference || !link.asset.selectedImage?.media) continue
        const current = references.get(link.assetId) || {
          link,
          storyboardIndexes: new Set<number>(),
          mentionCount: 0,
          appearsInFinalStoryboard: false,
        }
        current.storyboardIndexes.add(storyboardIndex)
        current.mentionCount += assetPromptMentionCount(storyboard.videoPrompt || '', link.asset.name)
        current.appearsInFinalStoryboard ||= storyboardIndex === storyboards.length - 1
        references.set(link.assetId, current)
      }
    }
    const availableReferenceCandidates = [...references.values()].map((candidate) => ({
      ...candidate.link,
      appearanceCount: candidate.storyboardIndexes.size,
      mentionCount: candidate.mentionCount,
      appearsInFinalStoryboard: candidate.appearsInFinalStoryboard,
    }))
    if (availableReferenceCandidates.length === 0) {
      throw new HttpError(422, 'STORYBOARD_REFERENCE_REQUIRED', '组合分镜没有匹配到已设置主图的人物、场景或道具')
    }
    const requiresHumanFaceReferences = (
      first.project.visualStyle === 'photorealistic'
      || first.project.visualStyle === 'overseas_live_action'
    ) && availableReferenceCandidates.some((link) => link.asset.type === AssetType.character)
    const textOnlyCharacters = requiresHumanFaceReferences
      && !modelDefinition.supportsHumanFaceReferences
    const totalReferenceCapacity = modelDefinition.maximumReferenceImages
      + (modelDefinition.maximumReferenceVideos || 0) * REFERENCE_MONTAGE_IMAGES_PER_VIDEO
    const referenceLinks = textOnlyCharacters
      ? []
      : prioritizeCombinedStoryboardReferences(
          availableReferenceCandidates,
          totalReferenceCapacity,
        )
    const referencePlan = planVideoReferences(
      referenceLinks.map((link) => link.assetId),
      modelDefinition.maximumReferenceImages,
      modelDefinition.maximumReferenceVideos || 0,
    )
    const referenceLinksByAssetId = new Map(referenceLinks.map((link) => [link.assetId, link]))
    const imageReferenceLinks = referencePlan.imageMediaIds
      .map((assetId) => referenceLinksByAssetId.get(assetId)!)
      .filter(Boolean)

    const fittedTimeline = fitVideoGroupDurations(
      storyboards.map((storyboard) => storyboard.duration),
      modelDefinition.maximumDuration,
      modelDefinition.supportedDurations,
      modelDefinition.minimumDuration,
      body.duration,
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

    const generateAudio = modelDefinition.supportsAudio && (body.generateAudio
      ?? storyboards.some((storyboard) => storyboard.generateAudio))
    const sourceStoryboardIds = storyboards.map((storyboard) => storyboard.id)
    const referenceOrderByAssetId = new Map(imageReferenceLinks.map((link, index) => [link.assetId, index + 1]))
    const actingByStoryboardId = new Map(await Promise.all(storyboards.map(async (storyboard) => {
      const performances = await getCompilableStoryboardPerformances(storyboard.id, referenceOrderByAssetId)
      return [storyboard.id, {
        performances,
        prompt: compileShotPerformancePrompt(performances, {
          includeVoice: generateAudio,
          maximumCharacters: Math.min(
            2400,
            Math.floor(videoModelPromptBudget(modelDefinition) * 0.32 / storyboards.length),
          ),
        }),
      }] as const
    })))
    const builtPrompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: first.project.visualStyle,
      customStylePrompt: first.project.customStylePrompt,
      maxLength: videoModelPromptBudget(modelDefinition),
      aspectRatio,
      outputDuration: duration,
      references: imageReferenceLinks.map((link, index) => ({
        referenceOrder: index + 1,
        type: link.asset.type,
        name: link.asset.name,
      })),
      characterNames: availableReferenceCandidates
        .filter((link) => link.asset.type === AssetType.character)
        .map((link) => link.asset.name),
      storyboards: storyboards.map((storyboard, index) => ({
        title: storyboard.title,
        duration: fittedTimeline.timelineDurations[index],
        videoPrompt: textOnlyCharacters
          ? `${appendShotPerformancePrompt(storyboard.videoPrompt || '', actingByStoryboardId.get(storyboard.id)?.prompt || '')}\n【人物生成方式】不上传任何人物或人脸参考图片，仅按分镜中的人物文字设定生成虚构演员；人物数量严格等于分镜，不复制人物。`
          : appendShotPerformancePrompt(
              storyboard.videoPrompt || '',
              actingByStoryboardId.get(storyboard.id)?.prompt || '',
            ),
        scriptSceneContext: buildStoryboardScriptSceneContext({
          script: storyboard.episode?.content,
          notes: storyboard.notes,
          locations: storyboard.assetLinks
            .filter((link) => link.asset.type === AssetType.location)
            .map((link) => link.asset),
        }),
      })),
    })
    const videoReferenceDescription = referencePlan.videoGroups.length > 0
      ? `\n【参考视频资产】\n${referencePlan.videoGroups.map((group, index) => (
          `参考视频 ${index + 1}：${group.map((assetId) => referenceLinksByAssetId.get(assetId)?.asset.name || assetId).join('、')}`
        )).join('\n')}`
      : ''
    let prompt = builtPrompt
    if (referencePlan.videoGroups.length > 0) {
      try {
        prompt = referenceMontagePrompt(
          `${builtPrompt}${videoReferenceDescription}`,
          modelDefinition.maximumPromptCharacters,
        )
      } catch {
        throw new HttpError(
          422,
          'VIDEO_PROMPT_TOO_LONG',
          `加入参考视频说明后，当前模型提示词最多 ${modelDefinition.maximumPromptCharacters} 字符`,
        )
      }
    }
    if (prompt.length > modelDefinition.maximumPromptCharacters) {
      throw new HttpError(
        422,
        'VIDEO_PROMPT_TOO_LONG',
        `当前模型提示词最多 ${modelDefinition.maximumPromptCharacters} 字符，压缩后仍为 ${prompt.length} 字符`,
      )
    }
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
          referenceImageAssetIds: referencePlan.imageMediaIds,
          referenceVideoAssetGroups: referencePlan.videoGroups,
          referencePlan,
          maximumReferenceImages: modelDefinition.maximumReferenceImages,
          maximumReferenceVideos: modelDefinition.maximumReferenceVideos || 0,
          referenceStrategy: textOnlyCharacters
            ? 'text_only_characters'
            : referencePlan.videoGroups.length > 0 ? 'asset_images_and_reference_videos' : 'asset_images',
          actingPerformanceCount: [...actingByStoryboardId.values()]
            .reduce((total, value) => total + value.performances.length, 0),
          actingProfileAssetIds: [...new Set(
            [...actingByStoryboardId.values()].flatMap((value) => (
              value.performances.map((performance) => performance.assetId)
            )),
          )],
          omittedReferenceAssetIds: availableReferenceCandidates
            .filter((link) => !referenceLinks.some((selected) => selected.assetId === link.assetId))
            .map((link) => link.assetId),
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
