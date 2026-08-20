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
  isExcludedStoryboardAssetLink,
  prioritizeStoryboardReferences,
  isManualStoryboardAssetLink,
  syncStoryboardAssetLinks,
  unboundStoryboardTimelineCharacters,
  visibleStoryboardTimelineCharacters,
} from '@/lib/storyboards'
import { normalizeVideoDuration } from '@/lib/video-batch'
import { resolveVideoModelDefinition, videoModelPromptBudget } from '@/lib/video-models'
import { DEFAULT_VIDEO_MODEL_ID } from '@/lib/video-defaults'
import {
  hasAnthropomorphicAssetDescription,
  prepareVideoPromptForProvider,
  shouldOmitVideoLocationReference,
} from '@/lib/video-prompt-safety'
import {
  previousStoryboardInSequence,
  shouldUsePreviousTailFrame,
  storyboardContinuityStateIssues,
  type ContinuityReferenceMode,
} from '@/lib/storyboard-continuity'
import {
  repairExactFinalStoryboardDialogueDuplicates,
  type FinalStoryboardDialogueDocument,
} from '@/lib/storyboard-dialogue-validation'
import { createStoryboardRevision } from '@/lib/storyboard-revisions'
import { getCompilableStoryboardPerformances } from '@/lib/acting-data'
import { appendShotPerformancePrompt, compileShotPerformancePrompt } from '@/lib/acting-system'
import {
  planVideoReferences,
  REFERENCE_MONTAGE_IMAGES_PER_VIDEO,
  referenceMontagePrompt,
} from '@/lib/video-reference-plan'

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

    if (current.episodeId) {
      const neighbors = await prisma.storyboard.findMany({
        where: {
          episodeId: current.episodeId,
          episodeSceneNumber: {
            gte: Math.max(1, (current.episodeSceneNumber || 1) - 1),
            lte: (current.episodeSceneNumber || 1) + 1,
          },
        },
        orderBy: { episodeSceneNumber: 'asc' },
      })
      const documents: FinalStoryboardDialogueDocument[] = neighbors.map((item) => ({
        id: item.id,
        number: item.episodeSceneNumber || item.sceneNumber,
        title: item.title,
        videoPrompt: item.videoPrompt || '',
      }))
      const repaired = repairExactFinalStoryboardDialogueDuplicates(
        documents,
        current.episode?.content || '',
      )
      if (repaired.issues.length > 0) {
        throw new HttpError(
          422,
          'STORYBOARD_FINAL_DIALOGUE_INVALID',
          `生成前检查发现相邻分镜重复台词：${repaired.issues.slice(0, 3).map((issue) => issue.message).join('；')}。请先调整台词分配，系统未消耗视频额度。`,
        )
      }
      const repairedById = new Map(repaired.documents.map((item) => [item.id, item.videoPrompt]))
      const changedNeighbors = neighbors.filter((item) => (
        repaired.changedDocumentIds.includes(item.id)
        && repairedById.get(item.id) !== (item.videoPrompt || '')
      ))
      if (changedNeighbors.length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const item of changedNeighbors) {
            await createStoryboardRevision(tx, item, {
              source: 'video_preflight_auto_repair',
              reason: '生成视频前自动删除相邻分镜完全重复台词',
              createdById: user.id,
              validationReport: { dialogueIssues: [], repairedDocumentIds: repaired.changedDocumentIds },
            })
            await tx.storyboard.update({
              where: { id: item.id },
              data: { videoPrompt: repairedById.get(item.id) || null },
            })
          }
        })
        await Promise.all(changedNeighbors.map((item) => syncStoryboardAssetLinks(item.id)))
      }
    }

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
    const requestedDuration = Math.max(storyboard.duration, body.duration ?? storyboard.duration)
    const aspectRatio = body.aspectRatio ?? storyboard.aspectRatio
    const generateAudio = body.generateAudio ?? true
    const model = body.model || env.videoModel() || DEFAULT_VIDEO_MODEL_ID
    const modelDefinition = await resolveVideoModelDefinition(model)
    if (!modelDefinition) {
      throw new HttpError(400, 'VIDEO_MODEL_NOT_ALLOWED', '该模型当前不可用，请刷新模型列表后重新选择')
    }
    const duration = normalizeVideoDuration(
      requestedDuration,
      modelDefinition.minimumDuration,
      modelDefinition.maximumDuration,
      modelDefinition.supportedDurations,
    )
    let continuityReference: {
      mediaId: string
      storageKey: string
      sourceVideoId: string
      mode: ContinuityReferenceMode
    } | null = null
    if (body.continuityFrameMediaId && body.continuitySourceVideoId) {
      const sourceVideo = await prisma.storyboardVideo.findUnique({
        where: { id: body.continuitySourceVideoId },
        select: {
          id: true,
          tailFrameMediaId: true,
          tailFrameMedia: { select: { id: true, storageKey: true, mimeType: true } },
          storyboard: {
            select: {
              id: true,
              projectId: true,
              episodeId: true,
              episodeSceneNumber: true,
              sceneNumber: true,
              notes: true,
              videoPrompt: true,
              continuityOut: true,
              selectedVideoId: true,
              episode: { select: { episodeNumber: true } },
            },
          },
        },
      })
      const projectSequence = await prisma.storyboard.findMany({
        where: { projectId: storyboard.projectId },
        select: {
          id: true,
          episodeId: true,
          episodeSceneNumber: true,
          sceneNumber: true,
          episode: { select: { episodeNumber: true } },
        },
      })
      const previousStoryboard = previousStoryboardInSequence(projectSequence, storyboard)
      if (!sourceVideo
        || sourceVideo.storyboard.projectId !== storyboard.projectId
        || previousStoryboard?.id !== sourceVideo.storyboard.id) {
        throw new HttpError(422, 'CONTINUITY_SOURCE_INVALID', '只能承接项目顺序中紧邻上一分镜的尾帧')
      }
      if (sourceVideo.storyboard.selectedVideoId !== sourceVideo.id) {
        throw new HttpError(422, 'CONTINUITY_SOURCE_NOT_SELECTED', '承接来源必须是上一分镜当前选中的视频版本')
      }
      if (sourceVideo.tailFrameMediaId !== body.continuityFrameMediaId
        || !sourceVideo.tailFrameMedia
        || !sourceVideo.tailFrameMedia.mimeType.startsWith('image/')) {
        throw new HttpError(422, 'CONTINUITY_FRAME_INVALID', '上一镜尾帧已失效，请重新截取')
      }
      const continuityMode: ContinuityReferenceMode = shouldUsePreviousTailFrame(
        sourceVideo.storyboard,
        storyboard,
      ) ? 'spatial' : 'visual'
      const continuityIssues = continuityMode === 'spatial'
        ? storyboardContinuityStateIssues(
            sourceVideo.storyboard.continuityOut,
            storyboard.continuityIn,
          )
        : []
      if (continuityMode === 'spatial' && continuityIssues.length > 0) {
        throw new HttpError(
          422,
          'STORYBOARD_CONTINUITY_INVALID',
          `当前分镜与上一镜状态冲突：${continuityIssues.join('；')}`,
        )
      }
      continuityReference = {
        mediaId: sourceVideo.tailFrameMedia.id,
        storageKey: sourceVideo.tailFrameMedia.storageKey,
        sourceVideoId: sourceVideo.id,
        mode: continuityMode,
      }
    }
    const matchedAssets = storyboard.assetLinks.filter((link) => (
      !isExcludedStoryboardAssetLink(link.matchReason)
    ))
    const availableReferences = matchedAssets.filter((link) => (
        (link.asset.type === AssetType.character || link.asset.type === AssetType.location || link.asset.type === AssetType.prop)
        && link.asset.selectedImage?.media
        && !(link.asset.type === AssetType.location
          && shouldOmitVideoLocationReference(link.asset.name))
      ))
    const requiresHumanFaceReferences = (
      storyboard.project.visualStyle === 'photorealistic'
      || storyboard.project.visualStyle === 'overseas_live_action'
    ) && availableReferences.some((link) => link.asset.type === AssetType.character)
    const textOnlyCharacters = requiresHumanFaceReferences
      && !modelDefinition.supportsHumanFaceReferences
    if (textOnlyCharacters && continuityReference) {
      throw new HttpError(
        422,
        'CONTINUITY_FACE_REFERENCE_UNSUPPORTED',
        '当前模型不支持真人参考图，无法使用上一镜尾帧承接',
      )
    }
    const assetReferenceLimit = Math.max(
      0,
      modelDefinition.maximumReferenceImages - (continuityReference ? 1 : 0),
    )
    const maximumReferenceVideos = modelDefinition.maximumReferenceVideos || 0
    const totalAssetReferenceCapacity = assetReferenceLimit
      + maximumReferenceVideos * REFERENCE_MONTAGE_IMAGES_PER_VIDEO
    const knownCharacterNames = matchedAssets
      .filter((link) => link.asset.type === AssetType.character)
      .map((link) => link.asset.name)
    const visibleCharacterNames = new Set([
      ...visibleStoryboardTimelineCharacters({
        videoPrompt: storyboard.videoPrompt || '',
        knownCharacterNames,
      }),
      ...matchedAssets
        .filter((link) => link.asset.type === AssetType.character && isManualStoryboardAssetLink(link.matchReason))
        .map((link) => link.asset.name),
    ])
    const generationReferences = availableReferences.filter((link) => (
      link.asset.type !== AssetType.character || visibleCharacterNames.has(link.asset.name)
    ))
    const references = textOnlyCharacters || totalAssetReferenceCapacity === 0
      ? []
      : prioritizeStoryboardReferences(
          generationReferences,
          totalAssetReferenceCapacity,
          { omitLocations: Boolean(continuityReference) },
        )
    const referencePlan = planVideoReferences(
      references.map((link) => link.assetId),
      assetReferenceLimit,
      maximumReferenceVideos,
    )
    const referencesByAssetId = new Map(references.map((link) => [link.assetId, link]))
    const imageReferences = referencePlan.imageMediaIds
      .map((assetId) => referencesByAssetId.get(assetId)!)
      .filter(Boolean)

    if (references.length === 0 && !continuityReference && !textOnlyCharacters) {
      const missing = matchedAssets.map((link) => link.asset.name).join('、')
      throw new HttpError(
        422,
        'STORYBOARD_REFERENCE_REQUIRED',
        missing
          ? `已识别资产但尚未设置主图：${missing}`
          : '分镜提示词未识别到资产，请在资产名称或标签中使用与分镜一致的名称',
      )
    }
    const referencedCharacterNames = references
      .filter((link) => link.asset.type === AssetType.character)
      .map((link) => link.asset.name)
    const unboundTimelineCharacters = unboundStoryboardTimelineCharacters({
      videoPrompt: storyboard.videoPrompt || '',
      knownCharacterNames,
      referencedCharacterNames,
    })
    if (!textOnlyCharacters && unboundTimelineCharacters.length > 0) {
      throw new HttpError(
        422,
        'VIDEO_VISIBLE_CHARACTER_UNBOUND',
        `本镜需要固定形象的人物超过当前模型 ${modelDefinition.maximumReferenceImages} 张参考图上限，尚未绑定：${unboundTimelineCharacters.join('、')}。场景已自动改用文字描述，不占参考图；请把本镜拆成每段不超过 ${modelDefinition.maximumReferenceImages} 名镜内人物后再生成。系统已阻止任务，避免换脸或动作错位。`,
      )
    }
    const usesTextSceneReference = !continuityReference
      && availableReferences.some((link) => link.asset.type === AssetType.location)
      && !references.some((link) => link.asset.type === AssetType.location)
    if (storyboard.project.visualStyle === 'overseas_live_action') {
      const explicitTransformationPattern = /变身|变为狼形|化为狼形|狼形实体|完整白狼形态/iu
      const conflictingAssets = references.flatMap((link) => {
        if (link.asset.type !== AssetType.character) return []
        const assetText = `${link.asset.description}\n${link.asset.prompt || ''}`
        const characterTimeline = (storyboard.videoPrompt || '')
          .split('\n')
          .filter((line) => line.includes(link.asset.name))
          .join('\n')
        return hasAnthropomorphicAssetDescription(assetText)
          && !explicitTransformationPattern.test(characterTimeline)
          ? [link.asset.name]
          : []
      })
      if (conflictingAssets.length > 0) {
        throw new HttpError(
          422,
          'OVERSEAS_LIVE_ACTION_ASSET_FORM_CONFLICT',
          `海外真人短剧要求普通状态使用完整真人演员，但以下人物资产包含兽人外观：${conflictingAssets.join('、')}。请先重新生成人类形态资产；系统已阻止继续生成狼头人身画面。`,
        )
      }
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
    const referenceOrderByAssetId = new Map(imageReferences.map((link, index) => [link.assetId, index + 1]))
    const actingPerformances = (await getCompilableStoryboardPerformances(
      storyboard.id,
      referenceOrderByAssetId,
    )).filter((performance) => visibleCharacterNames.has(performance.assetName))
    const actingPrompt = compileShotPerformancePrompt(actingPerformances, {
      includeVoice: generateAudio && modelDefinition.supportsAudio,
      maximumCharacters: Math.min(4500, Math.floor(videoModelPromptBudget(modelDefinition) * 0.4)),
    })
    const performanceReadyPrompt = appendShotPerformancePrompt(storyboard.videoPrompt || '', actingPrompt)
    const builtPrompt = buildStoryboardVideoPrompt({
      title: storyboard.title,
      videoPrompt: textOnlyCharacters
        ? `${performanceReadyPrompt}\n【人物生成方式】不上传任何人物或人脸参考图片，仅按分镜中的姓名、年龄、服装、体态、站位、动作和声音文字设定生成虚构演员；人物数量严格等于分镜，不复制人物。`
        : performanceReadyPrompt,
      scriptSceneContext: buildStoryboardScriptSceneContext({
        script: storyboard.episode?.content,
        notes: storyboard.notes,
        locations: matchedAssets
          .filter((link) => link.asset.type === 'location')
          .map((link) => link.asset),
      }),
      visualStyle: storyboard.project.visualStyle,
      customStylePrompt: storyboard.project.customStylePrompt,
      maxLength: videoModelPromptBudget(modelDefinition),
      duration,
      aspectRatio,
      knownCharacterNames,
      references: [
        ...imageReferences.map((link, index) => ({
          referenceOrder: index + 1,
          type: link.asset.type,
          name: link.asset.name,
        })),
        ...(continuityReference ? [{
          referenceOrder: imageReferences.length + 1,
          type: 'continuity' as const,
          name: '上一镜尾帧',
          continuityMode: continuityReference.mode,
        }] : []),
      ],
    })
    const videoReferenceDescription = referencePlan.videoGroups.length > 0
      ? `\n【参考视频资产】\n${referencePlan.videoGroups.map((group, index) => (
          `参考视频 ${index + 1}：${group.map((assetId) => referencesByAssetId.get(assetId)?.asset.name || assetId).join('、')}`
        )).join('\n')}`
      : ''
    let providerPrompt = builtPrompt
    if (referencePlan.videoGroups.length > 0) {
      try {
        providerPrompt = referenceMontagePrompt(
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
    const prompt = prepareVideoPromptForProvider(providerPrompt).prompt
    if (prompt.length > modelDefinition.maximumPromptCharacters) {
      throw new HttpError(
        422,
        'VIDEO_PROMPT_TOO_LONG',
        `当前模型提示词最多 ${modelDefinition.maximumPromptCharacters} 字符，压缩后仍为 ${prompt.length} 字符`,
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ lock_acquired: number }>>`
        SELECT 1::int AS lock_acquired
        FROM pg_advisory_xact_lock(hashtext(${`storyboard-video:${storyboard.id}`}))
      `
      const active = await tx.generationTask.findFirst({
        where: {
          storyboardId: storyboard.id,
          type: GenerationTaskType.video_generation,
          status: { in: ['queued', 'processing'] },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (active) return { task: active, reused: true as const }

      const task = await tx.generationTask.create({
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
            referenceImageAssetIds: referencePlan.imageMediaIds,
            referenceVideoAssetGroups: referencePlan.videoGroups,
            referencePlan,
            maximumReferenceImages: modelDefinition.maximumReferenceImages,
            maximumReferenceVideos,
            continuityFrameMediaId: continuityReference?.mediaId || null,
            continuitySourceVideoId: continuityReference?.sourceVideoId || null,
            continuityMode: continuityReference?.mode || null,
            continuityReplacesLocationReference: Boolean(continuityReference),
            referenceStrategy: textOnlyCharacters
              ? 'text_only_characters'
              : usesTextSceneReference ? 'character_images_scene_text' : 'asset_images',
            actingPerformanceCount: actingPerformances.length,
            actingProfileAssetIds: actingPerformances.map((performance) => performance.assetId),
          },
        },
      })
      return { task, reused: false as const }
    })

    if (!result.reused) {
      try {
        await enqueueVideoGenerationTask(result.task.id)
      } catch (error) {
        await prisma.generationTask.update({
          where: { id: result.task.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: `VIDEO_QUEUE_SUBMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          },
        })
        throw new HttpError(503, 'VIDEO_QUEUE_SUBMIT_FAILED', '视频任务暂时未能进入队列，请稍后重新生成')
      }
    }

    const taskPayload = result.task.payload && typeof result.task.payload === 'object' && !Array.isArray(result.task.payload)
      ? result.task.payload as Record<string, unknown>
      : {}
    const sourceStoryboardIds = Array.isArray(taskPayload.sourceStoryboardIds)
      ? taskPayload.sourceStoryboardIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [storyboard.id]

    return NextResponse.json({
      reused: result.reused,
      task: {
        id: result.task.id,
        type: result.task.type,
        status: result.task.status,
        progress: result.task.progress,
        model: result.task.model,
        projectId: result.task.projectId,
        storyboardId: result.task.storyboardId,
        sourceStoryboardIds,
        error: result.task.error,
        createdAt: result.task.createdAt.toISOString(),
      },
    }, { status: 202 })
  })
}
