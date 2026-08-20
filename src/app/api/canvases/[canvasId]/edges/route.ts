import { CanvasNodeType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createCanvasEdgeSchema, loadCanvas, serializeCanvas } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireCanvasAccess } from '@/lib/permissions'

export async function POST(request: NextRequest, context: { params: Promise<{ canvasId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { canvasId } = await context.params
    await requireCanvasAccess(canvasId, user.id)
    const body = createCanvasEdgeSchema.parse(await request.json())
    if (body.sourceNodeId === body.targetNodeId) throw new HttpError(422, 'CANVAS_EDGE_INVALID', '节点不能连接自己')
    const [source, target] = await Promise.all([
      prisma.canvasNode.findFirst({ where: { id: body.sourceNodeId, canvasId }, include: { media: true } }),
      prisma.canvasNode.findFirst({ where: { id: body.targetNodeId, canvasId } }),
    ])
    if (!source || !target) throw new HttpError(404, 'CANVAS_NODE_NOT_FOUND', '连线节点不存在')
    const validDirection = (
      source.type === CanvasNodeType.image
      && (target.type === CanvasNodeType.image || target.type === CanvasNodeType.video)
      && source.media?.mimeType.startsWith('image/')
    ) || (
      source.type === CanvasNodeType.video
      && target.type === CanvasNodeType.video
      && source.media?.mimeType.startsWith('video/')
    ) || (
      source.type === CanvasNodeType.audio
      && target.type === CanvasNodeType.video
      && source.media?.mimeType.startsWith('audio/')
    )
    if (!validDirection) {
      throw new HttpError(422, 'CANVAS_EDGE_DIRECTION', '图片可连接图片或视频节点；视频和音频只能连接视频节点')
    }
    const existing = await prisma.canvasEdge.findUnique({
      where: { sourceNodeId_targetNodeId: { sourceNodeId: source.id, targetNodeId: target.id } },
    })
    if (!existing) {
      const currentEdges = await prisma.canvasEdge.findMany({
        where: { canvasId, targetNodeId: target.id },
        include: { sourceNode: { select: { type: true } } },
        orderBy: { referenceOrder: 'asc' },
      })
      const typeCount = currentEdges.filter((edge) => edge.sourceNode.type === source.type).length
      const maximumReferences = target.type === CanvasNodeType.image
        ? 14
        : source.type === CanvasNodeType.image ? 30 : 3
      if (typeCount >= maximumReferences) {
        const label = source.type === CanvasNodeType.image ? '图片' : source.type === CanvasNodeType.video ? '视频' : '音频'
        throw new HttpError(422, 'CANVAS_REFERENCE_LIMIT', `一个生成节点最多连接 ${maximumReferences} 个${label}参考`)
      }
      await prisma.canvasEdge.create({
        data: {
          canvasId,
          sourceNodeId: source.id,
          targetNodeId: target.id,
          referenceOrder: (currentEdges.at(-1)?.referenceOrder || 0) + 1,
        },
      })
      await prisma.creativeCanvas.update({ where: { id: canvasId }, data: { updatedAt: new Date() } })
    }
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(canvasId, user.id)) }, { status: 201 })
  })
}
