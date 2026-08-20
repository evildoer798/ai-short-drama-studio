import { NextRequest, NextResponse } from 'next/server'
import { ProjectRole, VisualStyle } from '@prisma/client'
import { requireUser } from '@/lib/auth'
import { createDirectorSourceSnapshot, getDirectorHomeData } from '@/lib/director-data'
import { createDirectorProductionSchema } from '@/lib/director-system'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'

export async function GET() {
  return routeHandler(async () => {
    const user = await requireUser()
    return NextResponse.json(await getDirectorHomeData(user.id))
  })
}

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const body = createDirectorProductionSchema.parse(await request.json())

    if (body.mode === 'new') {
      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: body.workspaceId,
            userId: user.id,
          },
        },
      })
      if (!membership) {
        throw new HttpError(403, 'WORKSPACE_FORBIDDEN', '你没有在这个工作区中新建项目的权限')
      }

      const capturedAt = new Date().toISOString()
      const production = await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            workspaceId: body.workspaceId,
            name: body.projectName,
            visualStyle: VisualStyle.photorealistic,
            members: {
              create: { userId: user.id, role: ProjectRole.owner },
            },
          },
          select: { id: true, name: true, visualStyle: true, customStylePrompt: true },
        })
        await tx.novelSource.create({
          data: {
            projectId: project.id,
            title: body.scriptTitle,
            content: body.scriptContent,
          },
        })
        const episode = await tx.scriptEpisode.create({
          data: {
            projectId: project.id,
            episodeNumber: 1,
            title: body.scriptTitle,
            content: body.scriptContent,
            locked: true,
          },
          select: { id: true, episodeNumber: true, title: true, logline: true, content: true, locked: true },
        })
        return tx.directorProduction.create({
          data: {
            projectId: project.id,
            sourceEpisodeId: episode.id,
            createdById: user.id,
            name: body.name,
            sourceSnapshot: {
              capturedAt,
              project: {
                id: project.id,
                name: project.name,
                visualStyle: project.visualStyle,
                customStylePrompt: project.customStylePrompt,
              },
              episodes: [episode],
              assets: [],
            },
            settings: {
              stageConfirmationRequired: true,
              humanReview: true,
              sourceMode: 'uploaded-script',
            },
          },
          select: { id: true, name: true, currentStage: true },
        })
      })
      return NextResponse.json({ production }, { status: 201 })
    }

    await requireWritableProject(body.projectId, user.id)
    if (body.sourceEpisodeId) {
      const episode = await prisma.scriptEpisode.findUnique({
        where: { id: body.sourceEpisodeId }, select: { projectId: true },
      })
      if (!episode || episode.projectId !== body.projectId) {
        throw new HttpError(422, 'DIRECTOR_EPISODE_INVALID', '所选剧本不属于当前项目')
      }
    }
    const sourceSnapshot = await createDirectorSourceSnapshot(body.projectId, body.sourceEpisodeId)
    const production = await prisma.directorProduction.create({
      data: {
        projectId: body.projectId,
        sourceEpisodeId: body.sourceEpisodeId || null,
        createdById: user.id,
        name: body.name,
        sourceSnapshot,
        settings: { stageConfirmationRequired: true, humanReview: true },
      },
      select: { id: true, name: true, currentStage: true },
    })
    return NextResponse.json({ production }, { status: 201 })
  })
}
