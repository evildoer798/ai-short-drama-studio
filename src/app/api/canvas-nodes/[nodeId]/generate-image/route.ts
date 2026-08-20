import { CanvasNodeType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  generateCanvasImageSchema,
  normalizeCanvasImagePrompt,
} from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireCanvasNodeAccess } from '@/lib/permissions'
import { enqueueCanvasImageTask } from '@/lib/queue'

export async function POST(request: NextRequest, context: { params: Promise<{ nodeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { nodeId } = await context.params
    const node = await requireCanvasNodeAccess(nodeId, user.id)
    if (node.type !== CanvasNodeType.image || !node.model) {
      throw new HttpError(422, 'CANVAS_IMAGE_NODE_REQUIRED', '请选择图片生成节点')
    }
    const body = generateCanvasImageSchema.parse(await request.json())
    const references = await prisma.canvasEdge.findMany({
      where: { canvasId: node.canvasId, targetNodeId: node.id },
      include: { sourceNode: { include: { media: true } } },
      orderBy: { referenceOrder: 'asc' },
    })
    const validReferences = references.filter((edge) => (
      edge.sourceNode.type === CanvasNodeType.image && edge.sourceNode.media?.mimeType.startsWith('image/')
    ))
    if (validReferences.length !== references.length) {
      throw new HttpError(422, 'CANVAS_REFERENCE_INVALID', '部分连线图片已失效，请删除失效连线后再试')
    }
    if (validReferences.length > 14) {
      throw new HttpError(422, 'CANVAS_REFERENCE_LIMIT', '图片生成最多支持 14 张参考图')
    }
    const prompt = normalizeCanvasImagePrompt(body.prompt, validReferences.length)
    const referenceNodeIds = validReferences.map((edge) => edge.sourceNodeId)
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ lock_acquired: number }>>`
        SELECT 1::int AS lock_acquired
        FROM pg_advisory_xact_lock(hashtext(${`canvas-image:${node.id}`}))
      `
      const active = await tx.canvasImageTask.findFirst({
        where: { nodeId, status: { in: ['queued', 'processing'] } },
      })
      if (active) return { task: active, reused: true as const }

      await tx.canvasNode.update({
        where: { id: node.id },
        data: {
          prompt: body.prompt,
          model: body.model,
          aspectRatio: body.aspectRatio,
          resolution: body.resolution,
        },
      })
      await tx.creativeCanvas.update({ where: { id: node.canvasId }, data: { updatedAt: new Date() } })
      const task = await tx.canvasImageTask.create({
        data: {
          canvasId: node.canvasId,
          nodeId: node.id,
          createdById: user.id,
          model: body.model,
          prompt,
          aspectRatio: body.aspectRatio,
          resolution: body.resolution,
          count: body.count,
          referenceNodeIds,
          payload: {
            displayPrompt: body.prompt,
            referenceLabels: validReferences.map((edge, index) => ({
              token: `@图片${index + 1}`,
              nodeId: edge.sourceNodeId,
              title: edge.sourceNode.title,
            })),
          },
        },
      })
      return { task, reused: false as const }
    })
    if (!result.reused) {
      try {
        await enqueueCanvasImageTask(result.task.id)
      } catch (error) {
        await prisma.canvasImageTask.update({
          where: { id: result.task.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: `CANVAS_QUEUE_SUBMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          },
        })
        throw error
      }
    }
    return NextResponse.json({
      reused: result.reused,
      task: {
        id: result.task.id,
        status: result.task.status,
        progress: result.task.progress,
        error: result.task.error,
      },
    }, { status: 202 })
  })
}
