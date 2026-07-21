import { GenerationTaskType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import { createProjectRenderSchema } from '@/lib/project-renders'
import { enqueueProjectRenderTask } from '@/lib/queue'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = createProjectRenderSchema.parse(await request.json())

    const storyboards = await prisma.storyboard.findMany({
      where: { projectId },
      select: { id: true, title: true, sceneNumber: true, selectedVideoId: true },
      orderBy: [{ sceneNumber: 'asc' }, { createdAt: 'asc' }],
    })
    if (storyboards.length === 0) {
      throw new HttpError(422, 'PROJECT_STORYBOARD_REQUIRED', '请先创建分镜并生成视频')
    }
    const missing = storyboards.filter((storyboard) => !storyboard.selectedVideoId)
    if (missing.length > 0) {
      throw new HttpError(
        422,
        'PROJECT_RENDER_CLIP_MISSING',
        `以下分镜还没有选中视频：${missing.map((storyboard) => storyboard.title).join('、')}`,
      )
    }

    const approvedIds = storyboards.map((storyboard) => storyboard.selectedVideoId as string)
    const submittedIds = new Set(body.sourceVideoIds)
    const hasWrongVersion = body.sourceVideoIds.some((id) => !approvedIds.includes(id))
    const hasMissingScene = approvedIds.some((id) => !submittedIds.has(id))
    if (hasWrongVersion || hasMissingScene || submittedIds.size !== approvedIds.length) {
      throw new HttpError(
        422,
        'PROJECT_RENDER_SOURCE_INVALID',
        '时间线必须包含每条分镜当前选中的视频版本',
      )
    }

    const task = await prisma.generationTask.create({
      data: {
        type: GenerationTaskType.project_render,
        status: 'queued',
        projectId,
        createdById: user.id,
        provider: 'local-ffmpeg',
        model: 'ffmpeg-h264',
        prompt: `按时间线合成 ${body.sourceVideoIds.length} 条分镜视频`,
        requestedCount: 1,
        payload: {
          title: body.title,
          aspectRatio: body.aspectRatio,
          sourceVideoIds: body.sourceVideoIds,
        },
      },
    })
    await enqueueProjectRenderTask(task.id)

    return NextResponse.json({
      task: {
        id: task.id,
        type: task.type,
        status: task.status,
        progress: task.progress,
        projectId,
        error: task.error,
        createdAt: task.createdAt.toISOString(),
      },
    }, { status: 202 })
  })
}
