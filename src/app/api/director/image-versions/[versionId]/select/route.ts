import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'

export async function POST(_request: Request, context: { params: Promise<{ versionId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { versionId } = await context.params
    const version = await prisma.directorImageVersion.findUnique({
      where: { id: versionId }, include: { keyframe: { include: { production: true } } },
    })
    if (!version) throw new HttpError(404, 'DIRECTOR_IMAGE_VERSION_NOT_FOUND', '关键帧版本不存在')
    await requireProjectAccess(version.keyframe.production.projectId, user.id)
    await prisma.directorKeyframe.update({
      where: { id: version.keyframeId }, data: { selectedImageVersionId: version.id },
    })
    return NextResponse.json({ ok: true })
  })
}
