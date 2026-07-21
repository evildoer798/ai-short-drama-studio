import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'

const selectVideoSchema = z.object({
  videoId: z.string().min(1),
})

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const body = selectVideoSchema.parse(await request.json())
    const video = storyboard.videos.find((item) => item.id === body.videoId)
    if (!video) {
      throw new HttpError(404, 'STORYBOARD_VIDEO_NOT_FOUND', 'Storyboard video not found')
    }

    await prisma.$transaction([
      prisma.storyboardVideo.updateMany({
        where: { storyboardId },
        data: { isSelected: false },
      }),
      prisma.storyboardVideo.update({
        where: { id: video.id },
        data: { isSelected: true },
      }),
      prisma.storyboard.update({
        where: { id: storyboardId },
        data: { selectedVideoId: video.id },
      }),
    ])

    return NextResponse.json({ selectedVideoId: video.id })
  })
}
