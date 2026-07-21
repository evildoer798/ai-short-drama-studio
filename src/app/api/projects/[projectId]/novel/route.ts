import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import { getPreproductionData, saveNovelSchema } from '@/lib/preproduction'

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = saveNovelSchema.parse(await request.json())
    const existing = await prisma.novelSource.findUnique({ where: { projectId } })
    const changed = !existing || existing.title !== body.title || existing.content !== body.content

    await prisma.$transaction(async (tx) => {
      await tx.novelSource.upsert({
        where: { projectId },
        create: { projectId, title: body.title, content: body.content },
        update: { title: body.title, content: body.content },
      })
      if (changed) {
        await tx.scriptEpisode.updateMany({ where: { projectId }, data: { locked: false } })
      }
    })

    return NextResponse.json(await getPreproductionData(projectId))
  })
}
