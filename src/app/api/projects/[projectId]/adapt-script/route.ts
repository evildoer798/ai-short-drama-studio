import { GenerationTaskType } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import { adaptScriptSchema, createTextTask } from '@/lib/preproduction'

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireWritableProject(projectId, user.id)
    const body = adaptScriptSchema.parse(await request.json())
    const [source, episodeCount] = await Promise.all([
      prisma.novelSource.findUnique({ where: { projectId } }),
      prisma.scriptEpisode.count({ where: { projectId } }),
    ])
    if (!source) throw new HttpError(409, 'NOVEL_REQUIRED', '请先保存小说原文')
    if (episodeCount > 0 && !body.replaceExisting) {
      throw new HttpError(409, 'SCRIPT_EXISTS', '项目已有分集剧本，请确认替换后再重新改编')
    }
    const task = await createTextTask({
      type: GenerationTaskType.script_adaptation,
      projectId,
      createdById: user.id,
      prompt: `将《${source.title}》改编为 ${body.targetEpisodeCount} 集短剧`,
      payload: body,
    })
    return NextResponse.json({ task }, { status: 202 })
  })
}
