import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { requireWritableProject } from '@/lib/permissions'
import { routeHandler } from '@/lib/http'
import { visualStyleSchema } from '@/lib/visual-styles'

const updateProjectStyleSchema = z.object({
  visualStyle: visualStyleSchema,
  customStylePrompt: z.string().trim().max(8000).optional().nullable(),
})

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = updateProjectStyleSchema.parse(await request.json())

    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        visualStyle: body.visualStyle,
        customStylePrompt: body.customStylePrompt || null,
      },
      select: {
        id: true,
        visualStyle: true,
        customStylePrompt: true,
      },
    })

    return NextResponse.json({ project })
  })
}
