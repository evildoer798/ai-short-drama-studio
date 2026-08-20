import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { requireDirectorVideoTaskAccess } from '@/lib/permissions'

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { taskId } = await context.params
    const task = await requireDirectorVideoTaskAccess(taskId, user.id)
    return NextResponse.json({
      task: {
        id: task.id,
        shotId: task.shotId,
        status: task.status,
        progress: task.progress,
        error: task.error,
        completedAt: task.completedAt?.toISOString() || null,
        version: task.videoVersion ? {
          id: task.videoVersion.id,
          name: task.videoVersion.name,
          mediaId: task.videoVersion.mediaId,
          url: `/api/media/${task.videoVersion.mediaId}`,
        } : null,
      },
    })
  })
}
