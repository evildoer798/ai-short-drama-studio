import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import {
  buildStoryboardVideoDisplayName,
  renameStoryboardVideoSchema,
} from '@/lib/storyboard-video-names'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ videoId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { videoId } = await context.params
    const video = await prisma.storyboardVideo.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        createdAt: true,
        sourceStoryboardIds: true,
        storyboard: {
          select: {
            projectId: true,
            title: true,
            sceneNumber: true,
            episodeSceneNumber: true,
            episode: { select: { episodeNumber: true } },
          },
        },
      },
    })
    if (!video) {
      throw new HttpError(404, 'STORYBOARD_VIDEO_NOT_FOUND', '视频不存在')
    }
    await requireWritableProject(video.storyboard.projectId, user.id)
    const body = renameStoryboardVideoSchema.parse(await request.json())
    const updated = await prisma.storyboardVideo.update({
      where: { id: video.id },
      data: { name: body.name },
      select: { id: true, name: true },
    })

    return NextResponse.json({
      video: {
        id: updated.id,
        name: buildStoryboardVideoDisplayName({
          customName: updated.name,
          episodeNumber: video.storyboard.episode?.episodeNumber,
          storyboardNumber: video.storyboard.episodeSceneNumber || video.storyboard.sceneNumber,
          storyboardTitle: video.storyboard.title,
          sourceCount: video.sourceStoryboardIds.length || 1,
          createdAt: video.createdAt,
        }),
      },
    })
  })
}
