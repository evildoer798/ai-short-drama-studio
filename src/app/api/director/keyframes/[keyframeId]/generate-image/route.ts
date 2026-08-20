import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { HttpError, routeHandler } from '@/lib/http'
import { requireDirectorKeyframeAccess } from '@/lib/permissions'
import { enqueueDirectorImageTask } from '@/lib/queue'
import { liraStageOutputSchema } from '@/lib/director-system'

const schema = z.object({
  prompt: z.string().trim().min(1).max(10000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  referenceMediaIds: z.array(z.string().trim().min(1).max(200)).max(14).default([]),
})

export async function POST(request: NextRequest, context: { params: Promise<{ keyframeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { keyframeId } = await context.params
    const keyframe = await requireDirectorKeyframeAccess(keyframeId, user.id)
    if (keyframe.production.currentStage === 'acting' || keyframe.production.currentStage === 'lira') {
      throw new HttpError(409, 'DIRECTOR_KEYFRAME_LOCKED', '请先确认 LIRA 视觉资产阶段')
    }
    const unresolvedAssets = await prisma.directorCharacterStateAsset.count({
      where: { productionId: keyframe.productionId, selectedImageVersionId: null },
    })
    if (unresolvedAssets > 0) {
      throw new HttpError(409, 'DIRECTOR_CHARACTER_ASSETS_INCOMPLETE', `请先返回 LIRA 完成人物初始形象与状态图（还剩 ${unresolvedAssets} 项）`)
    }
    const body = schema.parse(await request.json().catch(() => ({})))
    const active = await prisma.directorImageTask.findFirst({
      where: { keyframeId, status: { in: ['queued', 'processing'] } }, orderBy: { createdAt: 'desc' },
    })
    if (active) return NextResponse.json({ task: active, reused: true }, { status: 202 })
    const allowedMediaIds = new Set(((keyframe.production.sourceSnapshot as { assets?: Array<{ selectedImage?: { mediaId?: string } | null }> }).assets || [])
      .flatMap((asset) => asset.selectedImage?.mediaId ? [asset.selectedImage.mediaId] : []))
    const lockedStateAssets = await prisma.directorCharacterStateAsset.findMany({
      where: { productionId: keyframe.productionId, selectedImageVersionId: { not: null } },
      include: { selectedImageVersion: { select: { mediaId: true } } },
    })
    for (const asset of lockedStateAssets) {
      if (asset.selectedImageVersion?.mediaId) allowedMediaIds.add(asset.selectedImageVersion.mediaId)
    }
    const liraRow = await prisma.directorStageVersion.findFirst({
      where: { productionId: keyframe.productionId, stage: 'lira', status: 'confirmed' },
      orderBy: { version: 'desc' }, select: { output: true },
    })
    const lira = liraRow?.output ? liraStageOutputSchema.parse(liraRow.output) : null
    const stateIds = lira?.keyframes.find((frame) => frame.shotKey === keyframe.shotKey)?.characterStateIds || []
    const automaticStateMediaIds = lockedStateAssets.flatMap((asset) => (
      stateIds.includes(asset.stateId) && asset.selectedImageVersion?.mediaId ? [asset.selectedImageVersion.mediaId] : []
    ))
    const referenceMediaIds = [...new Set([...automaticStateMediaIds, ...body.referenceMediaIds])].slice(0, 14)
    if (referenceMediaIds.some((mediaId) => !allowedMediaIds.has(mediaId))) {
      throw new HttpError(403, 'IMAGE_REFERENCE_FORBIDDEN', '参考图片不属于当前导演制作')
    }
    const validReferences = referenceMediaIds.length ? await prisma.mediaObject.count({
      where: { id: { in: referenceMediaIds }, mimeType: { startsWith: 'image/' } },
    }) : 0
    if (validReferences !== referenceMediaIds.length) throw new HttpError(422, 'IMAGE_REFERENCE_INVALID', '部分参考图片已失效')
    const task = await prisma.directorImageTask.create({
      data: {
        keyframeId,
        createdById: user.id,
        model: body.model || env.imageModel(),
        prompt: body.prompt || keyframe.prompt,
        referenceMediaIds,
        payload: { skill: 'LIRA', skillVersion: '2026-08-11', referenceMode: 'identity-context' },
      },
    })
    try {
      await enqueueDirectorImageTask(task.id)
    } catch (error) {
      await prisma.directorImageTask.update({
        where: { id: task.id }, data: { status: 'failed', completedAt: new Date(), error: String(error) },
      })
      throw error
    }
    return NextResponse.json({ task, reused: false }, { status: 202 })
  })
}
