import { NextRequest, NextResponse } from 'next/server'
import { CanvasNodeType } from '@prisma/client'
import { requireUser } from '@/lib/auth'
import { loadCanvas, serializeCanvas, updateCanvasNodeSchema } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireCanvasNodeAccess } from '@/lib/permissions'
import { deleteStorageObject } from '@/lib/storage'

export async function PATCH(request: NextRequest, context: { params: Promise<{ nodeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { nodeId } = await context.params
    const node = await requireCanvasNodeAccess(nodeId, user.id)
    const body = updateCanvasNodeSchema.parse(await request.json())
    await prisma.canvasNode.update({ where: { id: nodeId }, data: body })
    await prisma.creativeCanvas.update({ where: { id: node.canvasId }, data: { updatedAt: new Date() } })
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(node.canvasId, user.id)) })
  })
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ nodeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { nodeId } = await context.params
    const node = await requireCanvasNodeAccess(nodeId, user.id)
    if (
      node.videoTasks.some((task) => task.status === 'queued' || task.status === 'processing')
      || node.imageTasks.some((task) => task.status === 'queued' || task.status === 'processing')
      || node.audioTasks.some((task) => task.status === 'queued' || task.status === 'processing')
    ) {
      throw new HttpError(409, 'CANVAS_NODE_BUSY', '该节点仍在生成内容，暂时不能删除')
    }
    if (node.mediaId) {
      const [activeVideoReference, activeImageReference] = await Promise.all([
        prisma.canvasVideoTask.findFirst({
          where: { canvasId: node.canvasId, status: { in: ['queued', 'processing'] }, referenceNodeIds: { has: node.id } },
          select: { id: true },
        }),
        prisma.canvasImageTask.findFirst({
          where: { canvasId: node.canvasId, status: { in: ['queued', 'processing'] }, referenceNodeIds: { has: node.id } },
          select: { id: true },
        }),
      ])
      if (activeVideoReference || activeImageReference) {
        throw new HttpError(409, 'CANVAS_MEDIA_IN_USE', '该素材正在被生成任务使用，任务完成后才能删除')
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.canvasNode.delete({ where: { id: nodeId } })
      if (node.mediaId) await tx.mediaObject.delete({ where: { id: node.mediaId } })
      await tx.creativeCanvas.update({ where: { id: node.canvasId }, data: { updatedAt: new Date() } })
    })
    if (node.media?.storageKey) await deleteStorageObject(node.media.storageKey).catch(() => undefined)
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(node.canvasId, user.id)) })
  })
}
