import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { cinedanceShotSchema, preflightCinedanceShot } from '@/lib/director-system'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireDirectorShotAccess } from '@/lib/permissions'
import { enqueueDirectorVideoTask } from '@/lib/queue'
import { normalizeVideoDuration } from '@/lib/video-batch'
import { resolveVideoModelDefinition } from '@/lib/video-models'
import { planVideoReferences, referenceMontagePrompt } from '@/lib/video-reference-plan'

const schema = z.object({
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20000).optional(),
  duration: z.number().int().min(1).max(60).optional(),
  aspectRatio: z.string().trim().min(1).max(20).optional(),
  resolution: z.enum(['480p', '720p', '1080p', '2k', '4k']).default('720p'),
  generateAudio: z.boolean().default(true),
  referenceMediaIds: z.array(z.string().trim().min(1).max(200)).max(14).default([]),
})

export async function POST(request: NextRequest, context: { params: Promise<{ shotId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { shotId } = await context.params
    const shot = await requireDirectorShotAccess(shotId, user.id)
    if (shot.production.currentStage !== 'review' && shot.production.currentStage !== 'completed') {
      throw new HttpError(409, 'DIRECTOR_REVIEW_LOCKED', '请先确认 CINEDANCE 阶段')
    }
    const unresolvedAssets = await prisma.directorCharacterStateAsset.count({
      where: { productionId: shot.productionId, selectedImageVersionId: null },
    })
    if (unresolvedAssets > 0) {
      throw new HttpError(409, 'DIRECTOR_CHARACTER_ASSETS_INCOMPLETE', `请先返回 LIRA 完成人物初始形象与状态图（还剩 ${unresolvedAssets} 项）`)
    }
    const body = schema.parse(await request.json())
    const model = await resolveVideoModelDefinition(body.model)
    if (!model) throw new HttpError(400, 'VIDEO_MODEL_NOT_ALLOWED', '所选视频模型当前不可用')
    const referencePlan = planVideoReferences(
      body.referenceMediaIds,
      model.maximumReferenceImages,
      model.maximumReferenceVideos || 0,
    )
    const motionPlan = cinedanceShotSchema.parse(shot.motionPlan)
    const issues = preflightCinedanceShot(motionPlan)
    if (issues.length) throw new HttpError(422, 'DIRECTOR_PREFLIGHT_FAILED', issues.map((issue) => issue.message).join('；'))
    const aspectRatio = body.aspectRatio || shot.aspectRatio
    if (!(model.aspectRatios as string[]).includes(aspectRatio)) throw new HttpError(422, 'VIDEO_ASPECT_RATIO_NOT_SUPPORTED', '所选模型不支持该画幅')
    if (!model.resolutions.includes(body.resolution)) throw new HttpError(422, 'VIDEO_RESOLUTION_NOT_SUPPORTED', '所选模型不支持该清晰度')
    if (referencePlan.rejectedMediaIds.length > 0) {
      const videoMessage = model.maximumReferenceVideos
        ? `，另可把溢出的每张图片分别生成 1 段无声参考视频（最多 ${model.maximumReferenceVideos} 段）`
        : ''
      throw new HttpError(
        422,
        'VIDEO_REFERENCE_LIMIT',
        `当前模型最多支持 ${model.maximumReferenceImages} 张原图${videoMessage}，合计最多 ${referencePlan.totalCapacity} 项图片资产`,
      )
    }
    const sourceMediaIds = ((shot.production.sourceSnapshot as { assets?: Array<{ selectedImage?: { mediaId?: string } | null }> }).assets || [])
      .flatMap((asset) => asset.selectedImage?.mediaId ? [asset.selectedImage.mediaId] : [])
    const keyframeMedia = await prisma.directorKeyframe.findMany({
      where: { productionId: shot.productionId, selectedImageVersionId: { not: null } },
      select: { selectedImageVersion: { select: { mediaId: true } } },
    })
    const stateMedia = await prisma.directorCharacterStateAsset.findMany({
      where: { productionId: shot.productionId, selectedImageVersionId: { not: null } },
      select: { selectedImageVersion: { select: { mediaId: true } } },
    })
    const allowedMediaIds = new Set([
      ...sourceMediaIds,
      ...keyframeMedia.flatMap((frame) => frame.selectedImageVersion?.mediaId ? [frame.selectedImageVersion.mediaId] : []),
      ...stateMedia.flatMap((asset) => asset.selectedImageVersion?.mediaId ? [asset.selectedImageVersion.mediaId] : []),
    ])
    if (body.referenceMediaIds.some((mediaId) => !allowedMediaIds.has(mediaId))) {
      throw new HttpError(403, 'VIDEO_REFERENCE_FORBIDDEN', '参考图片不属于当前导演制作')
    }
    const references = body.referenceMediaIds.length ? await prisma.mediaObject.count({
      where: { id: { in: body.referenceMediaIds }, mimeType: { startsWith: 'image/' } },
    }) : 0
    if (references !== body.referenceMediaIds.length) throw new HttpError(422, 'VIDEO_REFERENCE_INVALID', '部分参考图片已失效')
    let prompt = body.prompt || shot.generationPrompt
    if (referencePlan.videoGroups.length > 0) {
      try {
        prompt = referenceMontagePrompt(prompt, model.maximumPromptCharacters)
      } catch {
        throw new HttpError(422, 'VIDEO_PROMPT_TOO_LONG', `加入参考视频说明后，当前模型提示词最多 ${model.maximumPromptCharacters} 字符`)
      }
    }
    if (prompt.length > model.maximumPromptCharacters) {
      throw new HttpError(422, 'VIDEO_PROMPT_TOO_LONG', `当前模型提示词最多 ${model.maximumPromptCharacters} 字符`)
    }
    const duration = normalizeVideoDuration(body.duration || shot.duration, model.minimumDuration, model.maximumDuration, model.supportedDurations)
    const existing = await prisma.directorVideoTask.findFirst({
      where: { shotId, status: { in: ['queued', 'processing'] } }, orderBy: { createdAt: 'desc' },
    })
    if (existing) return NextResponse.json({ task: existing, reused: true }, { status: 202 })
    const task = await prisma.directorVideoTask.create({
      data: {
        shotId, createdById: user.id, model: body.model, prompt, duration, aspectRatio,
        resolution: body.resolution, generateAudio: model.supportsAudio && body.generateAudio,
        referenceMediaIds: body.referenceMediaIds,
        payload: {
          preflightIssues: [],
          skill: 'CINEDANCE HIGGSFIELD',
          skillVersion: '2026-08-11',
          referencePlan,
        },
      },
    })
    try {
      await enqueueDirectorVideoTask(task.id)
    } catch (error) {
      await prisma.directorVideoTask.update({
        where: { id: task.id }, data: { status: 'failed', completedAt: new Date(), error: String(error) },
      })
      throw error
    }
    return NextResponse.json({ task, reused: false }, { status: 202 })
  })
}
