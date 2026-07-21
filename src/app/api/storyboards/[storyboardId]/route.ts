import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import { routeHandler } from '@/lib/http'
import {
  getProjectStoryboards,
  syncStoryboardAssetLinks,
  updateStoryboardSchema,
} from '@/lib/storyboards'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const body = updateStoryboardSchema.parse(await request.json())

    await prisma.storyboard.update({
      where: { id: storyboardId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(body.imagePrompt !== undefined ? { imagePrompt: body.imagePrompt || null } : {}),
        ...(body.videoPrompt !== undefined ? { videoPrompt: body.videoPrompt || null } : {}),
        ...(body.duration !== undefined ? { duration: body.duration } : {}),
        ...(body.aspectRatio !== undefined ? { aspectRatio: body.aspectRatio } : {}),
        ...(body.generateAudio !== undefined ? { generateAudio: body.generateAudio } : {}),
      },
    })

    if (body.videoPrompt !== undefined) {
      await syncStoryboardAssetLinks(storyboardId)
    }
    const storyboards = await getProjectStoryboards(storyboard.projectId)
    return NextResponse.json({
      storyboard: storyboards.find((item) => item.id === storyboardId),
    })
  })
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    await prisma.storyboard.delete({ where: { id: storyboardId } })
    return new NextResponse(null, { status: 204 })
  })
}
