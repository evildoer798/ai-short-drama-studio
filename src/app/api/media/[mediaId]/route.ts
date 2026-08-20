import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import {
  attachmentContentDisposition,
  extensionForMime,
  signedMediaUrl,
  streamStorageObject,
} from '@/lib/storage'
import {
  buildStoryboardVideoDisplayName,
  buildStoryboardVideoDownloadFilename,
} from '@/lib/storyboard-video-names'
import { resolveMediaProjectId } from '@/lib/media-access'

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ mediaId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { mediaId } = await context.params
    const media = await prisma.mediaObject.findUnique({
      where: { id: mediaId },
      include: {
        images: {
          include: { asset: true },
          take: 1,
        },
        storyboardVideos: {
          include: {
            storyboard: {
              include: { episode: { select: { episodeNumber: true } } },
            },
          },
          take: 1,
        },
        storyboardVideoTailFrames: {
          include: {
            storyboard: { select: { projectId: true } },
          },
          take: 1,
        },
        projectRenders: {
          select: { projectId: true, title: true },
          take: 1,
        },
        canvasNodes: {
          include: { canvas: { select: { userId: true } } },
          take: 1,
        },
        directorImageVersions: {
          include: {
            keyframe: { include: { production: { select: { projectId: true } } } },
          },
          take: 1,
        },
        directorVideoVersions: {
          include: {
            shot: { include: { production: { select: { projectId: true } } } },
          },
          take: 1,
        },
        directorStateImageVersions: {
          include: {
            stateAsset: { include: { production: { select: { projectId: true } } } },
          },
          take: 1,
        },
      },
    })

    const projectId = resolveMediaProjectId(media)
    const canvasOwnerId = media?.canvasNodes[0]?.canvas.userId
    if (!media || (!projectId && !canvasOwnerId)) {
      throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Media not found')
    }

    if (canvasOwnerId) {
      if (canvasOwnerId !== user.id) throw new HttpError(403, 'MEDIA_FORBIDDEN', 'Media access denied')
    } else {
      await requireProjectAccess(projectId!, user.id)
    }
    const download = _request.nextUrl.searchParams.get('download') === '1'
    const assetImage = media.images[0]
    const render = media.projectRenders[0]
    const storyboardVideo = media.storyboardVideos[0]
    const extension = extensionForMime(media.mimeType)
    const storyboardVideoName = storyboardVideo
      ? buildStoryboardVideoDisplayName({
        customName: storyboardVideo.name,
        episodeNumber: storyboardVideo.storyboard.episode?.episodeNumber,
        storyboardNumber: storyboardVideo.storyboard.episodeSceneNumber || storyboardVideo.storyboard.sceneNumber,
        storyboardTitle: storyboardVideo.storyboard.title,
        sourceCount: storyboardVideo.sourceStoryboardIds.length || 1,
        createdAt: storyboardVideo.createdAt,
      })
      : null
    const assetImageName = assetImage
      ? `${assetImage.asset.name}-${assetImage.asset.selectedImageId === assetImage.id ? '主图' : `版本${assetImage.variant}`}`
      : null
    const downloadFilename = download ? buildStoryboardVideoDownloadFilename({
      displayName: render?.title?.trim() || storyboardVideoName || assetImageName || `media-${media.id}`,
      extension,
    }) : undefined
    const proxy = _request.nextUrl.searchParams.get('proxy') === '1'
    const redirectToObjectStorage = !proxy && (
      media.mimeType.startsWith('image/')
      || media.mimeType.startsWith('video/')
      || media.mimeType.startsWith('audio/')
    )
    if (redirectToObjectStorage) {
      const location = await signedMediaUrl(media.storageKey, {
        downloadFilename,
      })
      return NextResponse.redirect(location, {
        status: 307,
        headers: {
          'Cache-Control': download
            ? 'private, no-store, max-age=0'
            : 'private, max-age=300',
        },
      })
    }
    const range = _request.headers.get('range') || undefined
    const object = await streamStorageObject(media.storageKey, range)
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': object.contentType || media.mimeType,
      'X-Content-Type-Options': 'nosniff',
    })
    if (object.contentLength !== undefined) {
      headers.set('Content-Length', String(object.contentLength))
    }
    if (object.contentRange) headers.set('Content-Range', object.contentRange)
    if (object.etag) headers.set('ETag', object.etag)
    if (object.lastModified) headers.set('Last-Modified', object.lastModified.toUTCString())
    if (downloadFilename) {
      headers.set('Content-Disposition', attachmentContentDisposition(downloadFilename))
    }

    return new NextResponse(object.body, {
      status: object.contentRange ? 206 : 200,
      headers,
    })
  })
}
