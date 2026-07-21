import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { normalizeTags, updateAssetSchema } from '@/lib/assets'
import { requireAssetAccess, requireWritableProject } from '@/lib/permissions'
import { routeHandler } from '@/lib/http'
import { deleteStorageObject } from '@/lib/storage'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    const existing = await requireAssetAccess(assetId, user.id)
    await requireWritableProject(existing.projectId, user.id)
    const body = updateAssetSchema.parse(await request.json())

    const asset = await prisma.asset.update({
      where: { id: assetId },
      data: {
        ...(body.type ? { type: body.type } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.tags !== undefined ? { tags: normalizeTags(body.tags) } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt || null } : {}),
        ...(body.videoPrompt !== undefined ? { videoPrompt: body.videoPrompt || null } : {}),
      },
    })

    return NextResponse.json({ asset })
  })
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    const asset = await requireAssetAccess(assetId, user.id)
    await requireWritableProject(asset.projectId, user.id)
    const media = asset.images.map((image) => image.media)
    await prisma.asset.delete({ where: { id: assetId } })

    const orphanedMedia = media.length > 0
      ? await prisma.mediaObject.findMany({
        where: {
          id: { in: media.map((item) => item.id) },
          images: { none: {} },
          storyboardVideos: { none: {} },
          projectRenders: { none: {} },
        },
        select: { id: true, storageKey: true },
      })
      : []
    if (orphanedMedia.length > 0) {
      await prisma.mediaObject.deleteMany({
        where: { id: { in: orphanedMedia.map((item) => item.id) } },
      })
      await Promise.allSettled(orphanedMedia.map((item) => deleteStorageObject(item.storageKey)))
    }

    return NextResponse.json({ ok: true, removedImages: orphanedMedia.length })
  })
}
