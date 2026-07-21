import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import { renameProjectSchema } from '@/lib/projects'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = renameProjectSchema.parse(await request.json())
    const project = await prisma.project.update({
      where: { id: projectId },
      data: { name: body.name },
      select: { id: true, name: true, updatedAt: true },
    })

    return NextResponse.json({
      project: {
        ...project,
        updatedAt: project.updatedAt.toISOString(),
      },
    })
  })
}
