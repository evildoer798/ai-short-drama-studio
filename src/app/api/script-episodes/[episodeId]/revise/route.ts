import { GenerationTaskType } from '@prisma/client'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireScriptEpisodeAccess, requireWritableProject } from '@/lib/permissions'
import { createTextTask } from '@/lib/preproduction'

export async function POST(
  _request: Request,
  context: { params: Promise<{ episodeId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { episodeId } = await context.params
    const episode = await requireScriptEpisodeAccess(episodeId, user.id)
    await requireWritableProject(episode.projectId, user.id)
    const unresolved = episode.comments.filter((comment) => !comment.resolved)
    if (unresolved.length === 0) {
      throw new HttpError(409, 'COMMENTS_REQUIRED', '请先选中剧本文字并添加修改意见')
    }
    const task = await createTextTask({
      type: GenerationTaskType.script_revision,
      projectId: episode.projectId,
      createdById: user.id,
      prompt: `根据 ${unresolved.length} 条导演评论修订第 ${episode.episodeNumber} 集`,
      payload: { episodeId },
    })
    return NextResponse.json({ task }, { status: 202 })
  })
}
