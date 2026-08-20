import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { reviewDirectorVideoSchema } from '@/lib/director-system'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'

export async function PATCH(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { versionId } = await context.params
    const body = reviewDirectorVideoSchema.parse(await request.json())
    const version = await prisma.directorVideoVersion.findUnique({
      where: { id: versionId }, include: { shot: { include: { production: true } } },
    })
    if (!version) throw new HttpError(404, 'DIRECTOR_VIDEO_VERSION_NOT_FOUND', '视频版本不存在')
    await requireProjectAccess(version.shot.production.projectId, user.id)
    await prisma.$transaction(async (tx) => {
      if (body.decision === 'selected') {
        await tx.directorVideoVersion.updateMany({
          where: { shotId: version.shotId, decision: 'selected' }, data: { decision: 'undecided' },
        })
        await tx.directorShot.update({ where: { id: version.shotId }, data: { selectedVideoVersionId: version.id } })
      } else if (version.shot.selectedVideoVersionId === version.id) {
        await tx.directorShot.update({ where: { id: version.shotId }, data: { selectedVideoVersionId: null } })
      }
      await tx.directorVideoVersion.update({
        where: { id: version.id }, data: { decision: body.decision, reviewNote: body.reviewNote ?? null },
      })
    })
    return NextResponse.json({ ok: true })
  })
}
