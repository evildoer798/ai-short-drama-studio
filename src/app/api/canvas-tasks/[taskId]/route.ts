import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { canvasMediaUrl, readableCanvasVideoError } from '@/lib/creative-canvas'
import { routeHandler } from '@/lib/http'
import { requireCanvasVideoTaskAccess } from '@/lib/permissions'

export async function GET(_request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { taskId } = await context.params
    const task = await requireCanvasVideoTaskAccess(taskId, user.id)
    return NextResponse.json({
      task: {
        id: task.id,
        nodeId: task.nodeId,
        status: task.status,
        progress: task.progress,
        error: task.status === 'failed' ? readableCanvasVideoError(task.error) : task.error,
        providerJobId: task.providerJobId,
        media: task.node.media ? {
          id: task.node.media.id,
          url: canvasMediaUrl(task.node.media.id),
          directUrl: `${canvasMediaUrl(task.node.media.id)}?direct=1`,
          downloadUrl: `${canvasMediaUrl(task.node.media.id)}?download=1`,
        } : null,
        completedAt: task.completedAt?.toISOString() || null,
      },
    })
  })
}
