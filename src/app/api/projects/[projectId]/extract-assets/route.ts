import { GenerationTaskType } from '@prisma/client'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import {
  createTextTask,
  extractAssetsSchema,
  requireEpisodesStoryboarded,
  requireLockedEpisodes,
} from '@/lib/preproduction'

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = extractAssetsSchema.parse(await request.json().catch(() => ({})))
    const episodes = await requireLockedEpisodes(projectId, body.episodeIds)
    await requireEpisodesStoryboarded(projectId, episodes.map((episode) => episode.id))
    const task = await createTextTask({
      type: GenerationTaskType.asset_extraction,
      projectId,
      createdById: user.id,
      prompt: `从已完成分镜的第 ${episodes.map((episode) => episode.episodeNumber).join('、')} 集提取角色、场景和核心道具资产提示词`,
      payload: body,
    })
    return NextResponse.json({ task }, { status: 202 })
  })
}
