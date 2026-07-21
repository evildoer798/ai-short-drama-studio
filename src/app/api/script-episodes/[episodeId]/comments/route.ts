import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireScriptEpisodeAccess, requireWritableProject } from '@/lib/permissions'
import { createScriptCommentSchema, getPreproductionData } from '@/lib/preproduction'

export async function POST(
  request: Request,
  context: { params: Promise<{ episodeId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { episodeId } = await context.params
    const episode = await requireScriptEpisodeAccess(episodeId, user.id)
    await requireWritableProject(episode.projectId, user.id)
    const body = createScriptCommentSchema.parse(await request.json())
    if (!episode.content.includes(body.quotedText)) {
      throw new HttpError(409, 'SCRIPT_SELECTION_CHANGED', '选中的文字已经变化，请重新选择后添加评论')
    }
    await prisma.$transaction([
      prisma.scriptComment.create({
        data: {
          episodeId,
          createdById: user.id,
          quotedText: body.quotedText,
          instruction: body.instruction,
          startOffset: body.startOffset,
          endOffset: body.endOffset,
        },
      }),
      prisma.scriptEpisode.update({ where: { id: episodeId }, data: { locked: false } }),
    ])
    return NextResponse.json(await getPreproductionData(episode.projectId), { status: 201 })
  })
}
