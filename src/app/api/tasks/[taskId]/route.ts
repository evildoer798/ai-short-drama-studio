import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import { textTaskProgressDetail } from '@/lib/text-task-progress'
import { reconcileTextTaskState } from '@/lib/text-task-recovery'

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { taskId } = await context.params
    const storedTask = await prisma.generationTask.findUnique({
      where: { id: taskId },
      include: {
        asset: {
          include: {
            images: {
              include: { media: true },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    })

    if (!storedTask) {
      throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found')
    }

    const task = await reconcileTextTaskState(storedTask, { autoRecoverFailed: true })
    const taskPayload = task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
      ? task.payload as Record<string, unknown>
      : {}
    const sourceStoryboardIds = Array.isArray(taskPayload.sourceStoryboardIds)
      ? taskPayload.sourceStoryboardIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : task.storyboardId ? [task.storyboardId] : []

    await requireProjectAccess(task.projectId, user.id)

    return NextResponse.json({
      task: {
        id: task.id,
        status: task.status,
        type: task.type,
        model: task.model,
        progress: task.progress,
        error: task.error,
        projectId: task.projectId,
        assetId: task.assetId,
        storyboardId: task.storyboardId,
        sourceStoryboardIds,
        requestedCount: task.requestedCount,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        detail: textTaskProgressDetail(task.payload),
      },
    })
  })
}
