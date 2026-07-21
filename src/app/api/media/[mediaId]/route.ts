import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import {
  attachmentContentDisposition,
  extensionForMime,
  streamStorageObject,
} from '@/lib/storage'

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
          include: { storyboard: true },
          take: 1,
        },
        projectRenders: {
          select: { projectId: true, title: true },
          take: 1,
        },
      },
    })

    const projectId = media?.images[0]?.asset.projectId
      || media?.storyboardVideos[0]?.storyboard.projectId
      || media?.projectRenders[0]?.projectId
    if (!media || !projectId) {
      throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Media not found')
    }

    await requireProjectAccess(projectId, user.id)
    const download = _request.nextUrl.searchParams.get('download') === '1'
    const render = media.projectRenders[0]
    const extension = extensionForMime(media.mimeType)
    const downloadFilename = download
      ? `${render?.title?.trim() || 'AI短剧成片'}.${extension}`
      : undefined
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
