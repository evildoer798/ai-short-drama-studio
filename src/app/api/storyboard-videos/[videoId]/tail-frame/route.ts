import { NextRequest, NextResponse } from 'next/server'
import {
  assetImageUploadMaxBytes,
  assetImageUrl,
  detectUploadedImageMimeType,
} from '@/lib/assets'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireWritableProject } from '@/lib/permissions'
import {
  buildStoryboardStorageKey,
  deleteStorageObject,
  uploadBuffer,
} from '@/lib/storage'

export async function POST(
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
        tailFrameMediaId: true,
        tailFrameMedia: { select: { storageKey: true } },
        storyboard: { select: { id: true, projectId: true } },
      },
    })
    if (!video) throw new HttpError(404, 'STORYBOARD_VIDEO_NOT_FOUND', '视频不存在')
    await requireWritableProject(video.storyboard.projectId, user.id)

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) {
      throw new HttpError(400, 'TAIL_FRAME_REQUIRED', '未获取到视频尾帧')
    }
    if (file.size > assetImageUploadMaxBytes) {
      throw new HttpError(413, 'TAIL_FRAME_TOO_LARGE', '尾帧图片不能超过 20MB')
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    const mimeType = detectUploadedImageMimeType(buffer)
    if (!mimeType) {
      throw new HttpError(415, 'TAIL_FRAME_UNSUPPORTED', '尾帧只支持 JPG、PNG 或 WebP')
    }
    const storageKey = buildStoryboardStorageKey({
      projectId: video.storyboard.projectId,
      storyboardId: video.storyboard.id,
      mimeType,
    })
    await uploadBuffer({ key: storageKey, body: buffer, mimeType })

    try {
      const media = await prisma.$transaction(async (tx) => {
        const created = await tx.mediaObject.create({
          data: {
            kind: 'image',
            storageKey,
            mimeType,
            sizeBytes: BigInt(buffer.byteLength),
          },
        })
        await tx.storyboardVideo.update({
          where: { id: video.id },
          data: { tailFrameMediaId: created.id },
        })
        if (video.tailFrameMediaId) {
          await tx.mediaObject.delete({ where: { id: video.tailFrameMediaId } })
        }
        return created
      })
      if (video.tailFrameMedia?.storageKey) {
        await deleteStorageObject(video.tailFrameMedia.storageKey).catch(() => undefined)
      }
      return NextResponse.json({
        tailFrame: {
          mediaId: media.id,
          url: assetImageUrl(media.id),
        },
      }, { status: 201 })
    } catch (error) {
      await deleteStorageObject(storageKey).catch(() => undefined)
      throw error
    }
  })
}
