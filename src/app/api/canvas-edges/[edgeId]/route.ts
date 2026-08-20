import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { loadCanvas, serializeCanvas } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'

export async function DELETE(_request: NextRequest, context: { params: Promise<{ edgeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { edgeId } = await context.params
    const edge = await prisma.canvasEdge.findUnique({ where: { id: edgeId }, include: { canvas: true } })
    if (!edge) throw new HttpError(404, 'CANVAS_EDGE_NOT_FOUND', '连线不存在')
    if (edge.canvas.userId !== user.id) throw new HttpError(403, 'CANVAS_FORBIDDEN', '无权修改该画布')
    await prisma.$transaction(async (tx) => {
      await tx.canvasEdge.delete({ where: { id: edgeId } })
      const remaining = await tx.canvasEdge.findMany({
        where: { canvasId: edge.canvasId, targetNodeId: edge.targetNodeId },
        orderBy: { referenceOrder: 'asc' },
      })
      for (let index = 0; index < remaining.length; index++) {
        await tx.canvasEdge.update({ where: { id: remaining[index].id }, data: { referenceOrder: index + 1 } })
      }
      await tx.creativeCanvas.update({ where: { id: edge.canvasId }, data: { updatedAt: new Date() } })
    })
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(edge.canvasId, user.id)) })
  })
}
