import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { HttpError, routeHandler } from '@/lib/http'
import { requireDirectorStateAssetAccess } from '@/lib/permissions'
import { enqueueDirectorStateImageTask } from '@/lib/queue'
import { identityMasterStateId, isIdentityMasterStateId } from '@/lib/director-state-assets'

const schema = z.object({
  prompt: z.string().trim().min(1).max(10000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
})

export async function POST(request: NextRequest, context: { params: Promise<{ stateAssetId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { stateAssetId } = await context.params
    const stateAsset = await requireDirectorStateAssetAccess(stateAssetId, user.id)
    const body = schema.parse(await request.json().catch(() => ({})))
    const active = await prisma.directorStateImageTask.findFirst({
      where: { stateAssetId, status: { in: ['queued', 'processing'] } }, orderBy: { createdAt: 'desc' },
    })
    if (active) return NextResponse.json({ task: active, reused: true }, { status: 202 })
    const isIdentityMaster = isIdentityMasterStateId(stateAsset.stateId)
    const snapshot = stateAsset.production.sourceSnapshot as {
      assets?: Array<{ id?: string; name?: string; selectedImage?: { mediaId?: string } | null }>
    }
    const normalize = (value?: string) => (value || '').trim().toLocaleLowerCase()
    const sourceIdentityMediaId = snapshot.assets?.find((asset) => (
      asset.id === stateAsset.assetId || normalize(asset.name) === normalize(stateAsset.assetName)
    ))?.selectedImage?.mediaId
    const identityMaster = isIdentityMaster ? null : await prisma.directorCharacterStateAsset.findUnique({
      where: {
        productionId_stateId: {
          productionId: stateAsset.productionId,
          stateId: identityMasterStateId(stateAsset.assetId),
        },
      },
      include: { selectedImageVersion: { select: { id: true, mediaId: true } } },
    })
    if (!isIdentityMaster && !identityMaster?.selectedImageVersion) {
      throw new HttpError(409, 'DIRECTOR_IDENTITY_MASTER_REQUIRED', `请先生成并锁定 ${stateAsset.assetName} 的初始形象`)
    }
    const referenceMediaIds = isIdentityMaster
      ? (sourceIdentityMediaId ? [sourceIdentityMediaId] : [])
      : [identityMaster!.selectedImageVersion!.mediaId]
    const task = await prisma.directorStateImageTask.create({
      data: {
        stateAssetId,
        createdById: user.id,
        model: body.model || env.imageModel(),
        prompt: body.prompt || stateAsset.prompt,
        referenceMediaIds,
        payload: {
          skill: 'LIRA', skillVersion: '2026-08-13',
          referenceMode: isIdentityMaster ? 'canonical-identity-master' : 'locked-identity-master',
          assetKind: isIdentityMaster ? 'identity-master' : 'state-variant',
          identityMasterVersionId: identityMaster?.selectedImageVersion?.id || null,
          stateId: stateAsset.stateId, soulIdRequired: stateAsset.soulIdRequired,
        },
      },
    })
    try {
      await enqueueDirectorStateImageTask(task.id)
    } catch (error) {
      await prisma.directorStateImageTask.update({
        where: { id: task.id }, data: { status: 'failed', completedAt: new Date(), error: String(error) },
      })
      throw error
    }
    return NextResponse.json({ task, reused: false }, { status: 202 })
  })
}
