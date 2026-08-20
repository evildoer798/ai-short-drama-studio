import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { loadCanvas, serializeCanvas, updateCanvasSchema } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { routeHandler } from '@/lib/http'
import { requireCanvasAccess } from '@/lib/permissions'
import { deleteStorageObject } from '@/lib/storage'

export async function GET(_request: NextRequest, context: { params: Promise<{ canvasId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { canvasId } = await context.params
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(canvasId, user.id)) })
  })
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ canvasId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { canvasId } = await context.params
    await requireCanvasAccess(canvasId, user.id)
    const body = updateCanvasSchema.parse(await request.json())
    await prisma.$transaction(async (tx) => {
      await tx.creativeCanvas.update({
        where: { id: canvasId },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.viewport ? {
            viewportX: body.viewport.x,
            viewportY: body.viewport.y,
            viewportZoom: body.viewport.zoom,
          } : {}),
          updatedAt: new Date(),
        },
      })
      for (const node of body.nodes || []) {
        await tx.canvasNode.updateMany({
          where: { id: node.id, canvasId },
          data: { positionX: node.positionX, positionY: node.positionY },
        })
      }
    })
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(canvasId, user.id)) })
  })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ canvasId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { canvasId } = await context.params
    await requireCanvasAccess(canvasId, user.id)
    const active = await prisma.canvasVideoTask.count({
      where: { canvasId, status: { in: ['queued', 'processing'] } },
    })
    if (active > 0) {
      return NextResponse.json({ error: { code: 'CANVAS_BUSY', message: '画布仍有视频任务运行，暂时不能删除' } }, { status: 409 })
    }
    const media = await prisma.canvasNode.findMany({
      where: { canvasId, mediaId: { not: null } },
      select: { mediaId: true, media: { select: { storageKey: true } } },
    })
    const mediaIds = media.flatMap((node) => node.mediaId ? [node.mediaId] : [])
    await prisma.$transaction(async (tx) => {
      await tx.creativeCanvas.delete({ where: { id: canvasId } })
      if (mediaIds.length > 0) await tx.mediaObject.deleteMany({ where: { id: { in: mediaIds } } })
    })
    await Promise.all(media.flatMap((node) => (
      node.media?.storageKey ? [deleteStorageObject(node.media.storageKey).catch(() => undefined)] : []
    )))
    return NextResponse.json({ ok: true })
  })
}
