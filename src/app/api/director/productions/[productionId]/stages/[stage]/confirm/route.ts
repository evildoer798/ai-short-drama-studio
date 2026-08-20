import { DirectorStage, DirectorStageStatus, Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  actingStageOutputSchema,
  cinedanceStageOutputSchema,
  directorStageSchema,
  liraStageOutputSchema,
  nextDirectorStage,
} from '@/lib/director-system'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireDirectorProductionAccess } from '@/lib/permissions'
import { syncDirectorCharacterStateAssets, unresolvedStateAssetIds } from '@/lib/director-state-assets'

export async function POST(_request: Request, context: { params: Promise<{ productionId: string; stage: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { productionId, stage: rawStage } = await context.params
    const stage = directorStageSchema.parse(rawStage)
    const production = await requireDirectorProductionAccess(productionId, user.id)
    if (production.currentStage !== stage) {
      throw new HttpError(409, 'DIRECTOR_STAGE_LOCKED', '该阶段尚未开放或已经确认')
    }
    const latest = await prisma.directorStageVersion.findFirst({
      where: { productionId, stage }, orderBy: { version: 'desc' },
    })
    if (!latest || latest.status !== DirectorStageStatus.ready || !latest.output) {
      throw new HttpError(409, 'DIRECTOR_STAGE_NOT_READY', '请先完成并检查本阶段结果')
    }
    if (stage === 'lira') {
      await syncDirectorCharacterStateAssets(productionId, latest.output)
      const stateAssets = await prisma.directorCharacterStateAsset.findMany({
        where: { productionId }, select: { stateId: true, selectedImageVersionId: true },
      })
      const unresolved = unresolvedStateAssetIds(stateAssets)
      if (unresolved.length > 0) {
        throw new HttpError(409, 'DIRECTOR_STATE_ASSETS_NOT_LOCKED', `请先生成并选定全部角色初始形象与状态图（还剩 ${unresolved.length} 项）`)
      }
    }
    const nextStage = nextDirectorStage(stage as DirectorStage)
    await prisma.$transaction(async (tx) => {
      await tx.directorStageVersion.update({
        where: { id: latest.id },
        data: { status: DirectorStageStatus.confirmed, confirmedById: user.id, confirmedAt: new Date() },
      })
      if (stage === 'lira') {
        const lira = liraStageOutputSchema.parse(latest.output)
        for (const frame of lira.keyframes) {
          const definitions = [
            { frameType: 'first' as const, prompt: frame.firstFramePrompt },
            ...(frame.endFramePrompt ? [{ frameType: 'end' as const, prompt: frame.endFramePrompt }] : []),
          ]
          for (const definition of definitions) {
            await tx.directorKeyframe.upsert({
              where: {
                productionId_shotKey_frameType: {
                  productionId,
                  shotKey: frame.shotKey,
                  frameType: definition.frameType,
                },
              },
              create: {
                productionId,
                shotKey: frame.shotKey,
                title: frame.shotTitle,
                frameType: definition.frameType,
                prompt: definition.prompt,
                aspectRatio: frame.aspectRatio,
              },
              update: {
                title: frame.shotTitle,
                prompt: definition.prompt,
                aspectRatio: frame.aspectRatio,
              },
            })
          }
        }
      }
      if (stage === 'cinedance') {
        const cinedance = cinedanceStageOutputSchema.parse(latest.output)
        const actingRow = await tx.directorStageVersion.findFirst({
          where: { productionId, stage: DirectorStage.acting, status: DirectorStageStatus.confirmed },
          orderBy: { version: 'desc' },
        })
        const liraRow = await tx.directorStageVersion.findFirst({
          where: { productionId, stage: DirectorStage.lira, status: DirectorStageStatus.confirmed },
          orderBy: { version: 'desc' },
        })
        const acting = actingRow?.output ? actingStageOutputSchema.parse(actingRow.output) : null
        const lira = liraRow?.output ? liraStageOutputSchema.parse(liraRow.output) : null
        for (const shot of cinedance.shots) {
          const performances = acting?.shotPerformances.filter((item) => item.shotKey === shot.shotKey) || []
          const keyframe = lira?.keyframes.find((item) => item.shotKey === shot.shotKey) || null
          await tx.directorShot.upsert({
            where: { productionId_order: { productionId, order: shot.order } },
            create: {
              productionId, order: shot.order, title: shot.title, scriptExcerpt: shot.scriptExcerpt,
              duration: shot.duration, aspectRatio: shot.aspectRatio,
              performance: performances as Prisma.InputJsonValue,
              visualPlan: (keyframe || {}) as Prisma.InputJsonValue,
              motionPlan: shot as Prisma.InputJsonValue,
              continuityIn: shot.continuityIn as Prisma.InputJsonValue,
              continuityOut: shot.continuityOut as Prisma.InputJsonValue,
              generationPrompt: shot.generationPrompt,
            },
            update: {
              title: shot.title, scriptExcerpt: shot.scriptExcerpt, duration: shot.duration,
              aspectRatio: shot.aspectRatio, performance: performances as Prisma.InputJsonValue,
              visualPlan: (keyframe || {}) as Prisma.InputJsonValue,
              motionPlan: shot as Prisma.InputJsonValue,
              continuityIn: shot.continuityIn as Prisma.InputJsonValue,
              continuityOut: shot.continuityOut as Prisma.InputJsonValue,
              generationPrompt: shot.generationPrompt,
            },
          })
        }
      }
      await tx.directorProduction.update({
        where: { id: productionId },
        data: {
          currentStage: nextStage,
          status: nextStage === DirectorStage.completed ? 'completed' : 'active',
        },
      })
    })
    return NextResponse.json({ currentStage: nextStage })
  })
}
