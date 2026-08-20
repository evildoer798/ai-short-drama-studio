import { CanvasNodeType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { generateCanvasAudioSchema, loadCanvas, serializeCanvas } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireCanvasNodeAccess } from '@/lib/permissions'
import { enqueueCanvasAudioTask } from '@/lib/queue'

export async function POST(request: NextRequest, context: { params: Promise<{ nodeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { nodeId } = await context.params
    const node = await requireCanvasNodeAccess(nodeId, user.id)
    if (node.type !== CanvasNodeType.audio || !node.model) {
      throw new HttpError(422, 'CANVAS_AUDIO_NODE_REQUIRED', '请选择参考音频生成节点')
    }
    const body = generateCanvasAudioSchema.parse(await request.json())
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ lock_acquired: number }>>`
        SELECT 1::int AS lock_acquired
        FROM pg_advisory_xact_lock(hashtext(${`canvas-audio:${node.id}`}))
      `
      const active = await tx.canvasAudioTask.findFirst({
        where: { nodeId, status: { in: ['queued', 'processing'] } },
      })
      if (active) return { task: active, reused: true as const }
      await tx.canvasNode.update({
        where: { id: node.id },
        data: { prompt: body.prompt, model: body.model },
      })
      const task = await tx.canvasAudioTask.create({
        data: {
          canvasId: node.canvasId,
          nodeId: node.id,
          createdById: user.id,
          model: body.model,
          prompt: body.prompt,
          payload: { displayPrompt: body.prompt },
        },
      })
      await tx.creativeCanvas.update({ where: { id: node.canvasId }, data: { updatedAt: new Date() } })
      return { task, reused: false as const }
    })
    if (!result.reused) {
      try {
        await enqueueCanvasAudioTask(result.task.id)
      } catch (error) {
        await prisma.canvasAudioTask.update({
          where: { id: result.task.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: `CANVAS_AUDIO_QUEUE_SUBMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
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
      canvas: serializeCanvas(await loadCanvas(node.canvasId, user.id)),
    }, { status: 202 })
  })
}
