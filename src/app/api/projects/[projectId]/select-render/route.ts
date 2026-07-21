import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import { selectProjectRenderSchema } from '@/lib/project-renders'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = selectProjectRenderSchema.parse(await request.json())
    const render = await prisma.projectRender.findFirst({
      where: { id: body.renderId, projectId },
      select: { id: true },
    })
    if (!render) {
      throw new HttpError(404, 'PROJECT_RENDER_NOT_FOUND', '成片版本不存在')
    }
    await prisma.project.update({
      where: { id: projectId },
      data: { selectedRenderId: render.id },
    })
    return NextResponse.json({ selectedRenderId: render.id })
  })
}
