import { GenerationTaskType } from '@prisma/client'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import {
  createTextTask,
  extractAssetsSchema,
  requireAllEpisodesLocked,
  requireAllEpisodesStoryboarded,
} from '@/lib/preproduction'

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    await requireAllEpisodesLocked(projectId)
    await requireAllEpisodesStoryboarded(projectId)
    const body = extractAssetsSchema.parse(await request.json().catch(() => ({})))
    const task = await createTextTask({
      type: GenerationTaskType.asset_extraction,
      projectId,
      createdById: user.id,
      prompt: '从已锁定分集剧本和已完成分镜提取角色、场景和道具资产提示词',
      payload: body,
    })
    return NextResponse.json({ task }, { status: 202 })
  })
}
