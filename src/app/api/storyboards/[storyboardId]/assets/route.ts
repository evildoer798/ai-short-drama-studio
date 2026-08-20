import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import {
  getProjectStoryboards,
  isExcludedStoryboardAssetLink,
  isManualStoryboardAssetLink,
  storyboardAssetExclusionReason,
} from '@/lib/storyboards'
import {
  insertStoryboardAssetMention,
  removeStoryboardAssetMention,
} from '@/lib/storyboard-asset-mentions'

const addStoryboardAssetSchema = z.object({
  assetId: z.string().trim().min(1),
  videoPrompt: z.string().max(30000).optional(),
})

const removeStoryboardAssetSchema = z.object({
  videoPrompt: z.string().max(30000).optional(),
})

async function storyboardResponse(projectId: string, storyboardId: string) {
  const storyboards = await getProjectStoryboards(projectId)
  const storyboard = storyboards.find((item) => item.id === storyboardId)
  if (!storyboard) throw new HttpError(404, 'STORYBOARD_NOT_FOUND', '分镜不存在')
  return NextResponse.json({ storyboard })
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const body = addStoryboardAssetSchema.parse(await request.json())
    const asset = await prisma.asset.findFirst({
      where: {
        id: body.assetId,
        projectId: storyboard.projectId,
        type: { in: ['character', 'location', 'prop'] },
      },
      select: { id: true, name: true, type: true },
    })
    if (!asset) {
      throw new HttpError(404, 'STORYBOARD_ASSET_NOT_FOUND', '只能添加当前项目中的角色、场景或道具资产')
    }

    const existing = storyboard.assetLinks.find((link) => link.assetId === asset.id)
    const videoPrompt = insertStoryboardAssetMention(
      body.videoPrompt ?? storyboard.videoPrompt ?? '',
      asset,
    )
    const nextOrder = storyboard.assetLinks.reduce(
      (maximum, link) => Math.max(maximum, link.referenceOrder),
      0,
    ) + 1
    await prisma.$transaction(async (tx) => {
      if (existing && isExcludedStoryboardAssetLink(existing.matchReason)) {
        await tx.storyboardAsset.update({
          where: { id: existing.id },
          data: {
            matchScore: 1_000,
            matchReason: `手动添加：${asset.name}`,
            referenceOrder: nextOrder,
          },
        })
      } else if (!existing) {
        await tx.storyboardAsset.create({
          data: {
            storyboardId,
            assetId: asset.id,
            matchScore: 1_000,
            matchReason: `手动添加：${asset.name}`,
            referenceOrder: nextOrder,
          },
        })
      }
      if (videoPrompt !== (storyboard.videoPrompt || '')) {
        await tx.storyboard.update({
          where: { id: storyboardId },
          data: { videoPrompt: videoPrompt || null },
        })
      }
    })

    return storyboardResponse(storyboard.projectId, storyboardId)
  })
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const body = removeStoryboardAssetSchema.parse(await request.json().catch(() => ({})))
    const assetId = request.nextUrl.searchParams.get('assetId')?.trim() || ''
    if (!assetId) throw new HttpError(400, 'STORYBOARD_ASSET_REQUIRED', '缺少资产 ID')

    const link = storyboard.assetLinks.find((item) => item.assetId === assetId)
    if (!link) return storyboardResponse(storyboard.projectId, storyboardId)
    const videoPrompt = removeStoryboardAssetMention(
      body.videoPrompt ?? storyboard.videoPrompt ?? '',
      link.asset.name,
    )
    await prisma.$transaction(async (tx) => {
      if (isManualStoryboardAssetLink(link.matchReason)) {
        await tx.storyboardAsset.delete({ where: { id: link.id } })
      } else if (!isExcludedStoryboardAssetLink(link.matchReason)) {
        await tx.storyboardAsset.update({
          where: { id: link.id },
          data: {
            matchScore: -1_000,
            matchReason: storyboardAssetExclusionReason(link.asset.name),
          },
        })
      }
      if (videoPrompt !== (storyboard.videoPrompt || '')) {
        await tx.storyboard.update({
          where: { id: storyboardId },
          data: { videoPrompt: videoPrompt || null },
        })
      }
    })
    return storyboardResponse(storyboard.projectId, storyboardId)
  })
}
