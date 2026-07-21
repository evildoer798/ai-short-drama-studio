import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireScriptEpisodeAccess, requireWritableProject } from '@/lib/permissions'
import { getPreproductionData, updateScriptEpisodeSchema } from '@/lib/preproduction'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ episodeId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { episodeId } = await context.params
    const episode = await requireScriptEpisodeAccess(episodeId, user.id)
    await requireWritableProject(episode.projectId, user.id)
    const body = updateScriptEpisodeSchema.parse(await request.json())
    if (body.locked === true && episode.comments.some((comment) => !comment.resolved)) {
      throw new HttpError(409, 'COMMENTS_UNRESOLVED', '请先处理或删除所有未解决评论，再锁定本集')
    }
    const contentChanged = body.content !== undefined || body.title !== undefined || body.logline !== undefined
    await prisma.scriptEpisode.update({
      where: { id: episodeId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.logline !== undefined ? { logline: body.logline || null } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.locked !== undefined ? { locked: body.locked } : contentChanged ? { locked: false } : {}),
      },
    })
    return NextResponse.json(await getPreproductionData(episode.projectId))
  })
}
