import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { requireProjectAccess, requireWritableProject } from '@/lib/permissions'
import { routeHandler } from '@/lib/http'
import {
  createStoryboardSchema,
  getProjectStoryboards,
  syncStoryboardAssetLinks,
} from '@/lib/storyboards'

export async function GET(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const projectId = request.nextUrl.searchParams.get('projectId') || ''
    await requireProjectAccess(projectId, user.id)
    const storyboards = await getProjectStoryboards(projectId)
    return NextResponse.json({ storyboards })
  })
}

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const body = createStoryboardSchema.parse(await request.json())
    await requireWritableProject(body.projectId, user.id)

    const latest = await prisma.storyboard.aggregate({
      where: { projectId: body.projectId },
      _max: { sceneNumber: true },
    })
    const storyboard = await prisma.storyboard.create({
      data: {
        projectId: body.projectId,
        title: body.title,
        sceneNumber: (latest._max.sceneNumber || 0) + 1,
        notes: body.notes || null,
        imagePrompt: body.imagePrompt || null,
        directorPrompt: body.directorPrompt || null,
        videoPrompt: body.videoPrompt,
        duration: body.duration,
        aspectRatio: body.aspectRatio,
        generateAudio: body.generateAudio,
      },
    })

    await syncStoryboardAssetLinks(storyboard.id)
    const storyboards = await getProjectStoryboards(body.projectId)
    return NextResponse.json({
      storyboard: storyboards.find((item) => item.id === storyboard.id),
    }, { status: 201 })
  })
}
