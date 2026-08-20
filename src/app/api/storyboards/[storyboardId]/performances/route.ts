import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import { reviewShotPerformance, shotPerformancesSchema } from '@/lib/acting-system'
import { getStoryboardPerformances } from '@/lib/acting-data'

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    await requireStoryboardAccess(storyboardId, user.id)
    return NextResponse.json({ performances: await getStoryboardPerformances(storyboardId) })
  })
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const body = shotPerformancesSchema.parse(await request.json())
    const outOfRangeBeat = body.performances.flatMap((performance) => performance.beats)
      .find((beat) => (
        (beat.startSeconds != null && beat.startSeconds > storyboard.duration)
        || (beat.endSeconds != null && beat.endSeconds > storyboard.duration)
      ))
    if (outOfRangeBeat) {
      throw new HttpError(
        422,
        'PERFORMANCE_BEAT_OUT_OF_RANGE',
        `表演节拍时间不能超过当前分镜时长 ${storyboard.duration} 秒`,
      )
    }
    const assetIds = body.performances.map((performance) => performance.assetId)
    const assets = assetIds.length > 0
      ? await prisma.asset.findMany({
          where: { id: { in: assetIds }, projectId: storyboard.projectId, type: 'character' },
          include: { actingProfile: true, voiceProfile: true },
        })
      : []
    if (assets.length !== new Set(assetIds).size) {
      throw new HttpError(422, 'SHOT_PERFORMANCE_ASSET_INVALID', '表演角色必须是当前项目中的角色资产')
    }
    const linkedAssetIds = new Set(storyboard.assetLinks.map((link) => link.assetId))
    const unlinked = assets.filter((asset) => !linkedAssetIds.has(asset.id))
    if (unlinked.length > 0) {
      throw new HttpError(
        422,
        'SHOT_PERFORMANCE_CHARACTER_NOT_IN_SHOT',
        `以下角色未绑定到当前分镜：${unlinked.map((asset) => asset.name).join('、')}`,
      )
    }
    const assetById = new Map(assets.map((asset) => [asset.id, asset]))

    await prisma.$transaction(async (tx) => {
      await tx.shotPerformance.deleteMany({
        where: {
          storyboardId,
          ...(assetIds.length > 0 ? { assetId: { notIn: assetIds } } : {}),
        },
      })
      for (const performance of body.performances) {
        const asset = assetById.get(performance.assetId)!
        const quality = reviewShotPerformance(performance, { hasEyeLife: Boolean(asset.actingProfile?.eyeLife) })
        const saved = await tx.shotPerformance.upsert({
          where: { storyboardId_assetId: { storyboardId, assetId: performance.assetId } },
          create: {
            storyboardId,
            assetId: performance.assetId,
            actingProfileId: asset.actingProfile?.id,
            voiceProfileId: asset.voiceProfile?.id,
            objective: performance.objective,
            obstacle: performance.obstacle,
            stakes: performance.stakes,
            subtext: performance.subtext || null,
            business: performance.business || null,
            statusIn: performance.statusIn || null,
            statusOut: performance.statusOut || null,
            proximityIn: performance.proximityIn || null,
            proximityOut: performance.proximityOut || null,
            sceneAdaptation: performance.sceneAdaptation || null,
            speaks: performance.speaks,
            qualityScore: quality.score,
            qualityReport: quality,
          },
          update: {
            actingProfileId: asset.actingProfile?.id,
            voiceProfileId: asset.voiceProfile?.id,
            objective: performance.objective,
            obstacle: performance.obstacle,
            stakes: performance.stakes,
            subtext: performance.subtext || null,
            business: performance.business || null,
            statusIn: performance.statusIn || null,
            statusOut: performance.statusOut || null,
            proximityIn: performance.proximityIn || null,
            proximityOut: performance.proximityOut || null,
            sceneAdaptation: performance.sceneAdaptation || null,
            speaks: performance.speaks,
            qualityScore: quality.score,
            qualityReport: quality,
          },
        })
        await tx.performanceBeat.deleteMany({ where: { shotPerformanceId: saved.id } })
        await tx.performanceBeat.createMany({
          data: performance.beats.map((beat) => ({
            shotPerformanceId: saved.id,
            order: beat.order,
            startSeconds: beat.startSeconds,
            endSeconds: beat.endSeconds,
            tactic: beat.tactic,
            trigger: beat.trigger || null,
            behavior: beat.behavior,
            reaction: beat.reaction || null,
            gaze: beat.gaze || null,
            posture: beat.posture || null,
            tempo: beat.tempo || null,
            voiceDelivery: beat.voiceDelivery || null,
            entryState: beat.entryState || null,
            exitState: beat.exitState || null,
          })),
        })
      }
    })

    return NextResponse.json({ performances: await getStoryboardPerformances(storyboardId) })
  })
}
