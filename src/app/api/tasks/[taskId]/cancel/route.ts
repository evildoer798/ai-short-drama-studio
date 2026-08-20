import { GenerationTaskType, Prisma, TaskStatus } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import { getVideoQueue } from '@/lib/queue'

function payloadRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { taskId } = await context.params
    const task = await prisma.generationTask.findUnique({ where: { id: taskId } })
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在')
    await requireProjectAccess(task.projectId, user.id)
    if (task.type !== GenerationTaskType.video_generation) {
      throw new HttpError(422, 'TASK_NOT_CANCELLABLE', '当前只支持取消视频生成任务')
    }

    const currentPayload = payloadRecord(task.payload)
    const sourceStoryboardIds = Array.isArray(currentPayload.sourceStoryboardIds)
      ? currentPayload.sourceStoryboardIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : task.storyboardId ? [task.storyboardId] : []
    if (task.status !== TaskStatus.queued && task.status !== TaskStatus.processing) {
      return NextResponse.json({
        cancelled: currentPayload.cancelRequested === true,
        task: {
          id: task.id,
          type: task.type,
          status: task.status,
          progress: task.progress,
          model: task.model,
          projectId: task.projectId,
          storyboardId: task.storyboardId,
          sourceStoryboardIds,
          error: task.error,
          createdAt: task.createdAt.toISOString(),
        },
      })
    }

    let queueState = 'missing'
    const job = await getVideoQueue().getJob(task.id)
    if (job) {
      queueState = await job.getState()
      if (queueState !== 'active') await job.remove()
    }

    const body = await request.json().catch(() => ({})) as { reason?: unknown }
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 300)
      : '用户取消了该视频生成任务。'
    const cancelledAt = new Date()
    const nextPayload: Prisma.InputJsonObject = {
      ...currentPayload,
      cancelRequested: true,
      cancelRequestedAt: cancelledAt.toISOString(),
      cancelQueueState: queueState,
    }
    const updated = await prisma.generationTask.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.failed,
        progress: task.progress,
        completedAt: cancelledAt,
        error: `VIDEO_TASK_CANCELLED: ${reason}`,
        payload: nextPayload,
      },
    })

    return NextResponse.json({
      cancelled: true,
      providerMayContinue: queueState === 'active' && Boolean(currentPayload.providerJobId),
      task: {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        progress: updated.progress,
        model: updated.model,
        projectId: updated.projectId,
        storyboardId: updated.storyboardId,
        sourceStoryboardIds,
        error: updated.error,
        createdAt: updated.createdAt.toISOString(),
      },
    })
  })
}
