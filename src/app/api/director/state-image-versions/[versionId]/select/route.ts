import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import {
  identityMasterStateId,
  identityMasterVersionIdFromPayload,
  isIdentityMasterStateId,
} from '@/lib/director-state-assets'

export async function POST(_request: Request, context: { params: Promise<{ versionId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { versionId } = await context.params
    const version = await prisma.directorStateImageVersion.findUnique({
      where: { id: versionId },
      include: { task: { select: { payload: true } }, stateAsset: { include: { production: true } } },
    })
    if (!version) throw new HttpError(404, 'DIRECTOR_STATE_IMAGE_VERSION_NOT_FOUND', '角色状态图版本不存在')
    await requireProjectAccess(version.stateAsset.production.projectId, user.id)
    const isIdentityMaster = isIdentityMasterStateId(version.stateAsset.stateId)
    if (!isIdentityMaster) {
      const identityMaster = await prisma.directorCharacterStateAsset.findUnique({
        where: {
          productionId_stateId: {
            productionId: version.stateAsset.productionId,
            stateId: identityMasterStateId(version.stateAsset.assetId),
          },
        },
        select: { selectedImageVersionId: true },
      })
      if (!identityMaster?.selectedImageVersionId) {
        throw new HttpError(409, 'DIRECTOR_IDENTITY_MASTER_REQUIRED', `请先锁定 ${version.stateAsset.assetName} 的初始形象`)
      }
      if (identityMasterVersionIdFromPayload(version.task.payload) !== identityMaster.selectedImageVersionId) {
        throw new HttpError(409, 'DIRECTOR_STATE_IMAGE_STALE', '这张状态图使用了旧的初始形象，请基于当前母版重新生成')
      }
    }
    await prisma.$transaction(async (tx) => {
      const previous = version.stateAsset.selectedImageVersionId
      await tx.directorCharacterStateAsset.update({
        where: { id: version.stateAssetId }, data: { selectedImageVersionId: version.id },
      })
      if (isIdentityMaster && previous !== version.id) {
        await tx.directorCharacterStateAsset.updateMany({
          where: {
            productionId: version.stateAsset.productionId,
            assetId: version.stateAsset.assetId,
            stateId: { not: version.stateAsset.stateId },
          },
          data: { selectedImageVersionId: null },
        })
      }
    })
    return NextResponse.json({ selectedImageVersionId: version.id })
  })
}
