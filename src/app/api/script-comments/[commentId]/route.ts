import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { requireScriptCommentAccess, requireWritableProject } from '@/lib/permissions'
import { getPreproductionData } from '@/lib/preproduction'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ commentId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { commentId } = await context.params
    const comment = await requireScriptCommentAccess(commentId, user.id)
    await requireWritableProject(comment.episode.projectId, user.id)
    await prisma.scriptComment.delete({ where: { id: commentId } })
    return NextResponse.json(await getPreproductionData(comment.episode.projectId))
  })
}
